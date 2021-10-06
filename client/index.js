let lastError = null;
let activeAbortController = new AbortController();
let activeSessionId;
let activeRanges = [[0,20]];
// rooms array is stored as a map since we just keep indices. E.g 0-99, 500-599, we don't want to have a 600 element array
let allRooms = {};
let allRoomsCount = 0;
const roomIdToRoom = {};

let debounceTimeoutId;
let visibleIndexes = {};

const intersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        let key = entry.target.id.substr("room".length);
        if (entry.isIntersecting) {
            visibleIndexes[key] = true;
        } else {
            delete visibleIndexes[key];
        }
    });
    // we will process the intersections after a short period of inactivity to not thrash the server
    clearTimeout(debounceTimeoutId);
    debounceTimeoutId = setTimeout(() => {
        let startIndex = 0;
        let endIndex = 0;
        Object.keys(visibleIndexes).forEach((i) => {
            i = Number(i);
            startIndex = startIndex || i;
            endIndex = endIndex || i;
            if (i < startIndex) {
                startIndex = i;
            }
            if (i > endIndex) {
                endIndex = i;
            }
        });
        // we don't need to request rooms between 0,20 as we always have a filter for this
        if (endIndex <= 20) {
            return;
        }
        // ensure we don't overlap with the 0,20 range
        if (startIndex < 20) {
            startIndex = 20;
        }
        // buffer range
        const bufferRange = 5;
        startIndex = (startIndex - bufferRange) < 0 ? 0 : (startIndex - bufferRange);
        endIndex = (endIndex + bufferRange) >= allRoomsCount ? allRoomsCount-1 : (endIndex + bufferRange);

        activeRanges[1] = [startIndex, endIndex];
        activeAbortController.abort();
        console.log("next: ", startIndex, "-", endIndex);
    }, 100);
}, {
    threshold: [0],
});

const renderMessage = (container, ev) => {
    const template = document.getElementById("messagetemplate");
    // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template#avoiding_documentfragment_pitfall
    const msgCell = template.content.firstElementChild.cloneNode(true);
    // placeholder
    msgCell.getElementsByClassName("msgsender")[0].textContent = ev.sender;
    let body = "";
    switch (ev.type) {
        case "m.room.message":
            body = ev.content.body;
            break;
        case "m.room.member":
            body = membershipChangeText(ev);
            break;
        default:
            body = ev.type + " event";
            break;
    }
    msgCell.getElementsByClassName("msgcontent")[0].textContent = body;
    container.appendChild(msgCell);
};

const onRoomClick = (e) => {
    let index = -1;
    // walk up the pointer event path until we find a room## id=
    for (let i = 0; i < e.path.length; i++) {
        if (e.path[i].id && e.path[i].id.startsWith("room")) {
            index = Number(e.path[i].id.substr("room".length));
        }
    }
    if (index === -1) {
        console.log("failed to find room for onclick");
        return;
    }
    const room = allRooms[index];
    console.log(allRooms[index]);
    document.getElementById("selectedroomname").textContent = room.name;
    // wipe all message entries
    const container = document.getElementById("messages")
    while (container.hasChildNodes()) {
        container.removeChild(container.firstChild);
    }
    // insert timeline messages
    (room.timeline || []).forEach((ev) => {
        renderMessage(container, ev);
    });
};

const render = (container) => {
    let addCount = 0;
    let removeCount = 0;
    // ensure we have the right number of children, remove or add appropriately.
    while (container.childElementCount > allRoomsCount) {
        intersectionObserver.unobserve(container.firstChild);
        container.removeChild(container.firstChild);
        removeCount += 1;
    }
    for (let i = container.childElementCount; i < allRoomsCount; i++) {
        const template = document.getElementById("roomCellTemplate");
        // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template#avoiding_documentfragment_pitfall
        const roomCell = template.content.firstElementChild.cloneNode(true);
        roomCell.setAttribute("id", "room"+i);
        // placeholder
        roomCell.getElementsByClassName("roomname")[0].textContent = randomName(i, false);
        roomCell.getElementsByClassName("roomcontent")[0].textContent = randomName(i, true);
        roomCell.getElementsByClassName("roominfo")[0].style = "filter: blur(5px);";
        container.appendChild(roomCell);
        intersectionObserver.observe(roomCell);
        roomCell.addEventListener("click", onRoomClick);
        addCount += 1;
    }
    if (addCount > 0 || removeCount > 0) {
        console.log("render: added ", addCount, "nodes, removed", removeCount, "nodes");
    }
    // loop all elements and modify the contents
    for (let i = 0; i < container.children.length; i++) {
        const roomCell = container.children[i];
        const r = allRooms[i];
        if (!r) {
            // placeholder
            roomCell.getElementsByClassName("roomname")[0].textContent = randomName(i, false);
            roomCell.getElementsByClassName("roomcontent")[0].textContent = randomName(i, true);
            roomCell.getElementsByClassName("roominfo")[0].style = "filter: blur(5px);";
            continue;
        }
        roomCell.getElementsByClassName("roominfo")[0].style = "";
        roomIdToRoom[r.room_id] = r;
        roomCell.getElementsByClassName("roomname")[0].textContent = r.name || r.room_id;
        if (r.timeline && r.timeline.length > 0) {
            const mostRecentEvent = r.timeline[r.timeline.length-1];
            roomCell.getElementsByClassName("roomsender")[0].textContent = mostRecentEvent.sender;
            const d = new Date(mostRecentEvent.origin_server_ts);
            roomCell.getElementsByClassName("roomtimestamp")[0].textContent = (
                d.toDateString() + " " + zeroPad(d.getHours()) + ":" + zeroPad(d.getMinutes()) + ":" + zeroPad(d.getSeconds())
            );

            if (mostRecentEvent.type === "m.room.message") {
                roomCell.getElementsByClassName("roomcontent")[0].textContent = mostRecentEvent.content.body;
            } else if (mostRecentEvent.type === "m.room.member") {
                roomCell.getElementsByClassName("roomcontent")[0].textContent = "";
                roomCell.getElementsByClassName("roomsender")[0].textContent = membershipChangeText(mostRecentEvent);
            } else if (mostRecentEvent.type) {
                roomCell.getElementsByClassName("roomcontent")[0].textContent = mostRecentEvent.type + " event";
            }
        } else {
            roomCell.getElementsByClassName("roomcontent")[0].textContent = "";
        }
    }
}
const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const doSyncLoop = async(accessToken, sessionId) => {
    console.log("Starting sync loop. Active: ", activeSessionId, " this:", sessionId);
    let currentPos;
    let currentError = null;
    while (sessionId === activeSessionId) {
        let resp;
        try {
            resp = await doSyncRequest(accessToken, currentPos, activeRanges, sessionId);
            currentPos = resp.pos;
            if (!resp.ops) {
                continue;
            }
            if (resp.count) {
                allRoomsCount = resp.count;
            }
        } catch (err) {
            if (err.name !== "AbortError") {
                console.error("/sync failed:",err);
                console.log("current", currentError, "last", lastError);
                if (currentError != lastError) {
                    console.log("set!");
                    document.getElementById("errorMsg").textContent = lastError ? lastError : "";
                }
                currentError = lastError;
                await sleep(1000);
            }
        }
        if (!resp) {
            continue;
        }

        let gapIndex = -1;
        resp.ops.forEach((op) => {
            if (op.op === "DELETE") {
                delete allRooms[op.index];
                gapIndex = op.index;
            } else if (op.op === "INSERT") {
                if (allRooms[op.index]) {
                    // something is in this space, shift items out of the way
                    if (gapIndex < 0) {
                        console.log("cannot work out where gap is, INSERT without previous DELETE!");
                        return;
                    }
                    //  0,1,2,3  index
                    // [A,B,C,D]
                    //   DEL 3
                    // [A,B,C,_]
                    //   INSERT E 0
                    // [E,A,B,C]
                    // gapIndex=3, op.index=0
                    if (gapIndex > op.index) {
                        // the gap is further down the list, shift every element to the right
                        // starting at the gap so we can just shift each element in turn
                        // [A,B,C,C] i=3
                        // [A,B,B,C] i=2
                        // [A,A,B,C] i=1
                        // Terminate. We'll assign into op.index next.
                        for (let i = gapIndex; i > op.index; i--) {
                            allRooms[i] = allRooms[i-1];
                        }
                    } else if (gapIndex < op.index) {
                        // the gap is further up the list, shift every element to the left
                        // starting at the gap so we can just shift each element in turn
                        for (let i = gapIndex; i < op.index; i++) {
                            allRooms[i] = allRooms[i+1];
                        }
                    }
                }
                allRooms[op.index] = op.room;
            } else if (op.op === "UPDATE") {
                allRooms[op.index] = op.room;
            } else if (op.op === "SYNC") {
                const startIndex = op.range[0];
                for (let i = startIndex; i <= op.range[1]; i++) {
                    allRooms[i] = op.rooms[i - startIndex];
                }
            } else if (op.op === "INVALIDATE") {
                const startIndex = op.range[0];
                for (let i = startIndex; i <= op.range[1]; i++) {
                    delete allRooms[i];
                }
            }
        });
        render(document.getElementById("listContainer"));
    }
    console.log("active session: ", activeSessionId, " this session: ", sessionId, " terminating.");
}
// accessToken = string, pos = int, ranges = [2]int e.g [0,99]
const doSyncRequest = async (accessToken, pos, ranges, sessionId) => {
    activeAbortController = new AbortController();
    let resp = await fetch("/_matrix/client/v3/sync" + (pos ? "?pos=" + pos : ""), {
        signal: activeAbortController.signal,
        method: "POST",
        headers: {
            "Authorization": "Bearer " + accessToken,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            rooms: ranges,
            session_id: (sessionId ? sessionId : undefined),
        })
    });
    let respBody = await resp.json();
    if (respBody.ops) {
        console.log(respBody);
    }
    if (resp.status != 200) {
        if (respBody.error) {
            lastError = respBody.error;
        }
        throw new Error("/sync returned HTTP " + resp.status + " " + respBody.error);
    }
    lastError = null;
    return respBody;
}

const membershipChangeText = (ev) => {
    const prevContent = (ev.unsigned || {}).prev_content || {};
    const prevMembership = prevContent.membership || "leave";
    const nowMembership = ev.content.membership;
    if (nowMembership != prevMembership) {
        switch (nowMembership) {
            case "join":
                return ev.state_key + " joined the room";
            case "leave":
                return ev.state_key + " left the room";
            case "ban":
                return ev.sender + " banned " + ev.state_key + " from the room";
            case "invite":
                return ev.sender + " invited " + ev.state_key + " to the room";
            case "knock":
                return ev.state_key + " knocked on the room";
        }
    }
    if (nowMembership == prevMembership && nowMembership == "join") {
        // display name or avatar change
        if (prevContent.displayname !== ev.content.displayname) {
            return ev.state_key + " set their name to " + ev.content.displayname;
        }
        if (prevContent.avatar_url !== ev.content.avatar_url) {
            return ev.state_key + " changed their profile picture";
        }
    }
    return ev.type + " event";
}

const randomName = (i, long) => {
    if (i % 17 === 0) {
        return long ? "Ever have that feeling where you’re not sure if you’re awake or dreaming?" : "There is no spoon";
    } else if (i % 13 === 0) {
        return long ? "Choice is an illusion created between those with power and those without." : "Get Up Trinity";
    } else if (i % 11 === 0) {
        return long ? "That’s how it is with people. Nobody cares how it works as long as it works.": "I know kung fu";
    } else if (i % 7 === 0) {
        return long ? "The body cannot live without the mind." : "Free your mind";
    } else if (i % 5 === 0) {
        return long ? "Perhaps we are asking the wrong questions…" : "Agent Smith";
    } else if (i % 3 === 0) {
        return long ? "You've been living in a dream world, Neo." : "Mr Anderson";
    } else {
        return long ? "Mr. Wizard, get me the hell out of here! " : "Morpheus";
    }
}

const zeroPad = (n) => {
    if (n < 10) {
        return "0" + n;
    }
    return n;
}

window.addEventListener('load', (event) => {
    const storedAccessToken = window.localStorage.getItem("accessToken");
    if (storedAccessToken) {
        document.getElementById("accessToken").value = storedAccessToken;
    }
    document.getElementById("syncButton").onclick = () => {
        const accessToken = document.getElementById("accessToken").value;
        window.localStorage.setItem("accessToken", accessToken);
        doSyncLoop(accessToken, activeSessionId);
    }
    document.getElementById("newsession").onclick = () => {
        activeSessionId = new Date().getTime() + "";
    }
});