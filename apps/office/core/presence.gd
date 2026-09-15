## Where an actor currently is in the office.
##
## The office has a finite floor, so attendance is explicit rather than implied by
## work state. A working agent holds a seat; an idle-but-alive one plays in the
## play room; a session that has ended leaves and frees its seat for the next
## entrant. This is the shift-change model.
class_name Presence
extends RefCounted

## Working: holds a seat at a desk.
const AT_WORK := "work"
## Alive but not working: plays in the play room, if one is free.
const PLAYING := "play"
## Alive, not working, and no play spot free: stays in the office and waits.
const WAITING := "waiting"
## The session is over: the actor has left the office.
const LEFT := "left"

## Labels for the sidebar, so presence is readable without colour.
const LABELS := {
	AT_WORK: "Working",
	PLAYING: "Playing",
	WAITING: "Waiting",
	LEFT: "Left",
}

## Whether a session with this work state is doing work the floor should show.
##
## A blocked agent is still on shift: it is mid-task and waiting on a decision, so
## it keeps its seat. Only an agent with nothing in hand goes to the play room.
static func is_working(work_state: int) -> bool:
	match work_state:
		WorkState.Kind.IDLE:
			return false
		WorkState.Kind.WAITING, WorkState.Kind.BLOCKED:
			return true
	return true


static func label(presence: String) -> String:
	return str(LABELS.get(presence, presence))


## True when the actor occupies floor space a newcomer could otherwise use.
static func occupies_space(presence: String) -> bool:
	return presence == AT_WORK or presence == PLAYING or presence == WAITING