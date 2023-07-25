package handler

import (
	"github.com/matrix-org/sliding-sync/sync3/caches"
	"time"
)

var maxDelay = 1 * time.Second

type TxnIDWaiter struct {
	userID              string
	publish             func(update caches.Update)
	subscribedOrVisible func(roomID string) bool
	// TODO: probably need a mutex around t.queues so the expiry won't race with enqueuing
	queues map[string][]*caches.RoomEventUpdate
}

func NewTxnIDWaiter(userID string, publish func(caches.Update), subscribedOrVisible func(string) bool) *TxnIDWaiter {
	return &TxnIDWaiter{
		userID:              userID,
		publish:             publish,
		subscribedOrVisible: subscribedOrVisible,
		queues:              make(map[string][]*caches.RoomEventUpdate),
		// TODO: metric that tracks how long events were queued for.
	}
}

func (t *TxnIDWaiter) Ingest(up caches.Update) {
	eventUpdate, isEventUpdate := up.(*caches.RoomEventUpdate)
	if !isEventUpdate {
		t.publish(up)
		return
	}

	roomID := eventUpdate.EventData.RoomID
	_, roomQueued := t.queues[roomID]
	// We only want to queue this event if our user sent it, or if the room already has queued events.
	if eventUpdate.EventData.Sender != t.userID && roomQueued {
		t.publish(up)
		return
	}

	// Don't bother queuing the event if the room isn't visible to the user.
	if !t.subscribedOrVisible(roomID) {
		t.publish(up)
		return
	}

	// We've decided to queue the event.
	queue, exists := t.queues[roomID]
	if !exists {
		queue = make([]*caches.RoomEventUpdate, 0, 10)
	}
	// TODO: bound the queue size?
	t.queues[roomID] = append(queue, eventUpdate)

	time.AfterFunc(maxDelay, func() { t.publishUpToNID(roomID, eventUpdate.EventData.NID) })
}

func (t *TxnIDWaiter) publishUpToNID(roomID string, publishNID int64) {
	queue, exists := t.queues[roomID]
	if !exists {
		return
	}

	var i int
	for i = 0; i < len(queue); i++ {
		// Scan forwards through the queue until we find an event with nid > publishNID.
		if queue[i].EventData.NID > publishNID {
			break
		}
	}
	// Now queue[:i] has events with nid <= publishNID, and queue[i:] has nids > publishNID.
	// strip off the first i events from the slice and publish them.
	toPublish, queue := queue[:i], queue[i:]
	for _, eventUpdate := range toPublish {
		t.publish(eventUpdate)
	}
}
