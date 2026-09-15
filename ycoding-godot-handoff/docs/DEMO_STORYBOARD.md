# Demo storyboard — genuine Godot capture

**Final evidence:** a normal-speed recording from the actual application, at least 60 seconds, or a shorter clip accompanied by stills that cover every hard criterion. Synthetic playback is visibly DEMO throughout. A separate short authorized LIVE recording proves ordinary prompt integration; it need not follow this predetermined storyline.

The shipped `fixtures/oauth-workplace.jsonl` runs from 0 to 82 seconds. Timestamps below 75 s are covered directly by that fixture; the 75–90 s rows describe optional additional real-application footage (longer close, history browsing) that the fixture does not schedule. Do not treat a 90-second fixture timeline as authored data — it is not.

The included `fixtures/oauth-workplace.jsonl` is synthetic client-internal input, not server wire. Implement it through the same store/director/actors as live mode. Screen actions such as opening the history drawer belong in the demo harness, not fake runtime events.

| Time | Scene | What the viewer learns |
|---|---|---|
| 0–8 s | Office establishing shot, idle coffee/stretch, normal text typed into composer | A coherent living workplace; no office scripting required |
| 8–20 s | Lead becomes attentive; delegation visit to Backend through doorway | Stand/turn/path/face/bubble micro-sequence and truthful source link |
| 20–32 s | Frontend receives work; Backend and Frontend type/read concurrently | Multiple workers, distinct desk animations, current status not delayed by travel |
| 32–45 s | Backend asks a real fixture question; lead answers; attention clears | Alternating source-backed bubbles and inspectable complete wording |
| 45–58 s | Backend report; QA begins verification while other activity continues | Result receipt, distinct test-state representation and no fake acknowledgments |
| 58–68 s | QA report and lead final response | Report-back behavior, human-readable outcome and exact source |
| 68–78 s | Select Backend, open full conversation and source session | Durable history, long text readability, current/past assignment identity |
| 78–82 s | Reconnect/rehydrate demonstration | Stale badge then recovered current state; old bubbles do not replay |
| 82–90 s | Optional: history browsing and calm office finish | Not scheduled by the fixture; recorded from the real application |

A shorter M2 capture contains only the lead/Backend visit, desk work, bubble/history opening and ambient preemption. Use accepted production-intent art at that stage; do not wait until the final demo to discover visual problems.

## Capture rules

Show build/mode somewhere readable. Include at least one doorway path, front/back prop overlap, seated alignment, direction change, conversation drawer, cancellation/preemption and a concurrent action. Keep normal speed; avoid jump cuts hiding path failures. Movie Maker output must use product-equivalent settings, not special effects enabled only for capture.

Do not hardcode live agent output so it matches a video. Never add a scripted “tests passed” bubble to a live run that did not verify tests. A synthetic test result is acceptable only in clearly labeled DEMO with a synthetic source record.

## Delivery bundle after implementation

Native app export for the tested target, MP4 demo, stills at 720p/1080p, build/engine/asset revision, replay input, test summary and known limitations. No credentials, private user prompts or raw provider traces. Instructions for engine capture and optional MP4 conversion are in [LOCAL_SETUP.md](LOCAL_SETUP.md).
