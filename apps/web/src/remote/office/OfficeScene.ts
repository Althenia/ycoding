import Phaser from "phaser"
import { OfficeDirector } from "./director"
import type { OfficeMailbox } from "./bridge"
import { columns, floorFrameAt, officeLayout, props, rows, tileSize, wallAt, wallFrameAt, worldHeight, worldWidth } from "./map"
import { rallyBall } from "./leisure"
import { shortText } from "./model"
import { hasReducedMotion } from "./preferences"
import { characterAppearances, characterColumns, characterDirections, characterFrame } from "./sprites"
import type { ActorFrame, OfficeCue, OfficeSnapshot } from "./types"

const importedAssets = import.meta.glob<string>("./assets/*.png", { eager: true, query: "?url&no-inline", import: "default" })
const textureURLs = Object.fromEntries(Object.entries(importedAssets).map(([filename, url]) => [filename.slice(filename.lastIndexOf("/") + 1, -4), url]))

type ActorObjects = {
  sprite: Phaser.GameObjects.Sprite
  shadow: Phaser.GameObjects.Ellipse
  ring: Phaser.GameObjects.Ellipse
  label: Phaser.GameObjects.Text
  labelPlate: Phaser.GameObjects.Graphics
  bubble: Phaser.GameObjects.Text
  bubblePlate: Phaser.GameObjects.Graphics
  marker: Phaser.GameObjects.Text
}

export class OfficeScene extends Phaser.Scene {
  private readonly director = new OfficeDirector(officeLayout)
  private readonly objects = new Map<string, ActorObjects>()
  private readonly seenCues = new Set<string>()
  private badgeQueue: OfficeCue[] = []
  private badge?: Phaser.GameObjects.Text
  private ball?: Phaser.GameObjects.Ellipse
  private badgeActorID?: string
  private badgeUntil = 0
  private cueScope = ""
  private cueRootID?: string
  private lastConnection: OfficeSnapshot["connection"] = "unavailable"
  private applied = -1
  private selectedID?: string
  private drag?: { x: number; y: number; scrollX: number; scrollY: number }
  private ready = false
  private failed = false
  private followSuspended = false
  private desiredZoom: number
  private fitting = false
  private latestFrames: readonly ActorFrame[] = []
  private lastLocations = ""

  constructor(private readonly mailbox: OfficeMailbox, private readonly selectSession: (id: string) => void, private readonly fail: (message: string) => void, private readonly resolution: number, private readonly onLocations: (locations: Readonly<Record<string, ActorFrame["room"]>>) => void, private readonly fonts: { readonly sans: string; readonly mono: string }) {
    super({ key: "office" })
    this.desiredZoom = resolution
  }

  preload(): void {
    for (const key of ["tiles", "walls", "characters", ...new Set(props.map((prop) => prop.kind))]) {
      if (textureURLs[key]) continue
      this.failed = true
      this.fail("An office asset failed to load. The normal workspace remains available.")
      return
    }
    this.load.spritesheet("tiles", textureURLs.tiles, { frameWidth: 32, frameHeight: 32 })
    this.load.spritesheet("walls", textureURLs.walls, { frameWidth: 32, frameHeight: 32 })
    this.load.spritesheet("characters", textureURLs.characters, { frameWidth: 32, frameHeight: 48 })
    for (const kind of new Set(props.map((prop) => prop.kind))) this.load.image(kind, textureURLs[kind])
    this.load.once("loaderror", () => {
      this.failed = true
      this.fail("An office asset failed to load. The normal workspace remains available.")
    })
  }

  create(): void {
    if (this.failed) return
    if (!["tiles", "walls", "characters", ...new Set(props.map((prop) => prop.kind))].every((key) => this.textures.exists(key))) {
      this.failed = true
      this.fail("An office asset failed to load. The normal workspace remains available.")
      return
    }
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      this.add.image(x * tileSize, y * tileSize, "tiles", floorFrameAt(x, y)).setOrigin(0).setDepth(-2000)
      if (wallAt(x, y)) this.add.image(x * tileSize, y * tileSize, "walls", wallFrameAt(x, y))
        .setOrigin(0).setDepth((y + 1) * tileSize - 1)
    }
    for (const door of [officeLayout.door, { x: officeLayout.door.x + 1, y: officeLayout.door.y }]) {
      this.add.image(door.x * tileSize, door.y * tileSize, "walls", door.y === rows - 1 ? 3 : 2)
        .setOrigin(0).setDepth((door.y + 1) * tileSize - 1)
    }
    for (const prop of props) {
      const image = this.add.image(prop.cell.x * tileSize, prop.layer === "floor" ? prop.cell.y * tileSize : (prop.cell.y + prop.height) * tileSize, prop.kind)
      if (prop.layer === "floor") image.setOrigin(0).setDisplaySize(prop.width * tileSize, prop.height * tileSize).setDepth(-1900)
      if (prop.layer === "object") image.setOrigin(0, 1).setScale(prop.width * tileSize / image.width).setDepth((prop.cell.y + prop.height) * tileSize - 1)
    }
    this.ball = this.add.ellipse(0, 0, 6, 6, 0xf7f5ec).setStrokeStyle(1, 0x3d4e5b).setDepth(896).setVisible(false)
    this.badge = this.add.text(0, 0, "", { fontFamily: this.fonts.mono, fontSize: "13px", color: "#1e2934", backgroundColor: "#f4bd3d", padding: { x: 6, y: 3 }, resolution: this.resolution })
      .setOrigin(0.5, 1).setDepth(10007).setVisible(false)
    for (let appearance = 0; appearance < characterAppearances; appearance++) for (const direction of characterDirections) {
      for (const [pose, columns, speed] of [
        ["stand", characterColumns.stand, 1], ["walk", characterColumns.walk, 8],
        ["talk", characterColumns.talk, 3], ["type", characterColumns.type, 4], ["play", characterColumns.talk, 2],
      ] as const) {
        this.anims.create({ key: `${appearance}-${direction}-${pose}`,
          frames: this.anims.generateFrameNumbers("characters", { start: characterFrame(appearance, direction, columns[0]), end: characterFrame(appearance, direction, columns[columns.length - 1]!) }),
          frameRate: speed, repeat: -1 })
      }
    }
    this.desiredZoom = this.workingZoom()
    this.cameras.main.setZoom(this.desiredZoom)
    this.boundCamera()
    this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2)
    const canvas = this.sys.game.canvas
    const endDrag = () => { this.drag = undefined; delete canvas.dataset.cursor }
    this.input.setDefaultCursor("var(--yc-cursor-pan)")
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.drag = { x: pointer.x, y: pointer.y, scrollX: this.cameras.main.scrollX, scrollY: this.cameras.main.scrollY }
      canvas.dataset.cursor = "panning"
    })
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown || !this.drag) return
      if (pointer.getDistance() >= 6) this.followSuspended = true
      this.cameras.main.setScroll(this.drag.scrollX - (pointer.x - this.drag.x) / this.cameras.main.zoom, this.drag.scrollY - (pointer.y - this.drag.y) / this.cameras.main.zoom)
    })
    this.input.on("pointerup", endDrag)
    this.input.on("pointerupoutside", endDrag)
    this.input.on("gameout", endDrag)
    this.events.once("destroy", endDrag)
    this.cueScope = this.mailbox.read().snapshot.scope
    this.cueRootID = this.mailbox.read().snapshot.team.rootActorID
    this.lastConnection = this.mailbox.read().snapshot.connection
    for (const cue of this.mailbox.read().snapshot.cues) this.seenCues.add(cue.id)
    this.events.once("shutdown", () => {
      endDrag()
      this.objects.clear(); this.badge = undefined; this.ball = undefined
      this.badgeQueue = []; this.seenCues.clear(); this.ready = false
    })
    this.ready = true
  }

  fit(): void {
    if (!this.ready) return
    this.followSuspended = true
    this.fitting = true
    this.desiredZoom = this.minimumZoom()
    this.cameras.main.setZoom(this.desiredZoom)
    this.boundCamera()
    this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2)
  }

  zoomBy(factor: number): void {
    if (!this.ready) return
    this.fitting = false
    this.desiredZoom = Phaser.Math.Clamp(this.cameras.main.zoom * factor, this.minimumZoom(), Math.max(this.minimumZoom(), this.resolution * 2))
    this.cameras.main.setZoom(this.desiredZoom)
    this.boundCamera()
  }

  panBy(x: number, y: number): void {
    if (!this.ready) return
    this.followSuspended = true
    const camera = this.cameras.main
    camera.setScroll(camera.scrollX + x * this.resolution / camera.zoom, camera.scrollY + y * this.resolution / camera.zoom)
  }

  resize(): void {
    if (!this.ready) return
    this.desiredZoom = this.fitting ? this.minimumZoom() : Math.max(this.desiredZoom, this.minimumZoom())
    this.cameras.main.setZoom(this.desiredZoom)
    this.boundCamera()
    if (this.fitting) this.cameras.main.centerOn(worldWidth / 2, worldHeight / 2)
  }

  defaultView(): void {
    if (!this.ready) return
    this.fitting = false
    this.desiredZoom = this.workingZoom()
    this.cameras.main.setZoom(this.desiredZoom)
    this.boundCamera()
    this.followSuspended = false
    const selected = this.latestFrames.find((frame) => frame.actor.selected)
    this.cameras.main.centerOn(selected?.position.x ?? worldWidth / 2, selected?.position.y ?? worldHeight / 2)
  }

  follow(): void {
    this.followSuspended = false
    const selected = this.latestFrames.find((frame) => frame.actor.selected)
    if (selected) this.cameras.main.centerOn(selected.position.x, selected.position.y)
  }

  focus(actorID: string): void {
    const actor = this.latestFrames.find((frame) => frame.actor.id === actorID && !frame.leaving)
    if (!actor) return
    this.followSuspended = false
    this.cameras.main.centerOn(actor.position.x, actor.position.y)
  }

  settle(): void { this.director.settle() }

  refreshFonts(): void {
    if (!this.ready) return
    this.badge?.style.update(true)
    for (const objects of this.objects.values()) {
      objects.label.style.update(true)
      objects.bubble.style.update(true)
      objects.marker.style.update(true)
    }
    this.update(this.time.now, 0)
  }

  adoptLatest(): void {
    const snapshot = this.mailbox.read().snapshot
    if (snapshot.scope !== this.cueScope || snapshot.team.rootActorID !== this.cueRootID) this.seenCues.clear()
    this.cueScope = snapshot.scope
    this.cueRootID = snapshot.team.rootActorID
    for (const cue of snapshot.cues) this.seenCues.add(cue.id)
    this.badgeQueue = []
    this.badge?.setVisible(false)
    this.director.settle()
  }

  private boundCamera(): void {
    const camera = this.cameras.main
    const insetX = Math.max(0, (this.scale.width / camera.zoom - worldWidth) / 2)
    const insetY = Math.max(0, (this.scale.height / camera.zoom - worldHeight) / 2)
    camera.setBounds(-insetX, -insetY, worldWidth + insetX * 2, worldHeight + insetY * 2)
  }

  private minimumZoom(): number {
    return Math.min(this.scale.width / worldWidth, this.scale.height / worldHeight)
  }

  private workingZoom(): number {
    return Math.max(this.scale.width / worldWidth, this.scale.height / worldHeight, this.resolution * 0.65)
  }

  override update(time: number, delta: number): void {
    if (!this.ready) return
    this.desiredZoom = this.fitting ? this.minimumZoom() : Math.max(this.desiredZoom, this.minimumZoom())
    if (this.cameras.main.zoom !== this.desiredZoom) {
      this.cameras.main.setZoom(this.desiredZoom)
      this.boundCamera()
    }
    const input = this.mailbox.read()
    const reduced = hasReducedMotion(input.preferences, input.systemReduced)
    if (this.applied !== this.mailbox.revision()) {
      this.director.sync(input.snapshot)
      if (input.snapshot.connection !== "ready" || this.lastConnection !== "ready") {
        this.badgeQueue = []
        for (const cue of input.snapshot.cues) this.seenCues.add(cue.id)
        this.director.settle()
        this.badge?.setVisible(false)
      }
      this.discoverCues(input.snapshot, reduced)
      this.lastConnection = input.snapshot.connection
      this.applied = this.mailbox.revision()
    }
    if (reduced && this.badgeQueue.length && time >= this.badgeUntil) this.showCueBadge(this.badgeQueue.shift()!, time)
    this.latestFrames = this.director.tick(delta, reduced)
    const locations = Object.fromEntries(this.latestFrames.map((frame) => [frame.actor.id, frame.room]))
    const locationKey = JSON.stringify(locations)
    if (locationKey !== this.lastLocations) {
      this.lastLocations = locationKey
      this.onLocations(locations)
    }
    const scale = this.resolution / this.cameras.main.zoom
    const present = new Set(this.latestFrames.map((frame) => frame.actor.id))
    for (const [id, objects] of this.objects) {
      if (present.has(id)) continue
      objects.sprite.destroy(); objects.shadow.destroy(); objects.ring.destroy(); objects.label.destroy(); objects.labelPlate.destroy()
      objects.bubble.destroy(); objects.bubblePlate.destroy(); objects.marker.destroy()
      this.objects.delete(id)
    }
    for (const frame of this.latestFrames) this.paintActor(frame, input.snapshot, scale)
    const ball = rallyBall(this.latestFrames, time)
    if (ball) this.ball?.setPosition(ball.x, ball.y)
    this.ball?.setVisible(ball !== undefined)
    this.placeBubbles(scale)
    this.placeLabels(scale)
    const target = this.latestFrames.find((frame) => frame.actor.id === this.badgeActorID)
    this.badge?.setVisible(time < this.badgeUntil && !!target)
    if (target) this.badge?.setPosition(target.position.x, target.position.y - 80).setScale(scale)
    const selected = this.latestFrames.find((frame) => frame.actor.selected)
    if (this.selectedID === undefined && selected && !this.fitting) this.cameras.main.centerOn(selected.position.x, selected.position.y)
    if (selected?.actor.id !== this.selectedID) this.followSuspended = false
    if (input.preferences.followSelected && selected && !this.followSuspended) this.cameras.main.centerOn(selected.position.x, selected.position.y)
    this.selectedID = selected?.actor.id
  }

  private discoverCues(snapshot: OfficeSnapshot, reduced: boolean): void {
    if (snapshot.scope !== this.cueScope || snapshot.team.rootActorID !== this.cueRootID) {
      this.cueScope = snapshot.scope
      this.cueRootID = snapshot.team.rootActorID
      this.seenCues.clear()
      this.badgeQueue = []
      this.badge?.setVisible(false)
      for (const cue of snapshot.cues) this.seenCues.add(cue.id)
      return
    }
    const visible = new Set(snapshot.cues.map((cue) => cue.id))
    this.badgeQueue = this.badgeQueue.filter((cue) => visible.has(cue.id))
    for (const cue of snapshot.cues) {
      if (this.seenCues.has(cue.id)) continue
      this.seenCues.add(cue.id)
      if (reduced) this.badgeQueue.push(cue)
      if (!reduced) this.director.playCue(cue)
    }
  }

  private showCueBadge(cue: OfficeCue, time: number): void {
    this.badge?.setText(cue.kind === "delegate" ? "Delegated" : "Reported")
    this.badgeActorID = cue.toActorID
    this.badgeUntil = time + 750
  }

  private placeBubbles(scale: number): void {
    const view = this.cameras.main.worldView
    const spacing = 8 * scale
    const placed: { left: number; right: number; top: number; bottom: number }[] = []
    for (const frame of [...this.latestFrames].sort((a, b) => Number(b.actor.selected) - Number(a.actor.selected))) {
      const objects = this.objects.get(frame.actor.id)
      if (!objects?.bubble.visible) continue
      const width = objects.bubble.displayWidth + 18 * scale
      const height = objects.bubble.displayHeight + 10 * scale
      const x = Phaser.Math.Clamp(frame.position.x, view.left + width / 2 + spacing, view.right - width / 2 - spacing)
      const y = frame.position.y - objects.sprite.displayHeight - 8
      const candidates = [0, -height - spacing, height + spacing, -2 * (height + spacing), 2 * (height + spacing)]
        .flatMap((dy) => [0, -width / 2, width / 2].map((dx) => ({
          left: x + dx - width / 2, right: x + dx + width / 2,
          top: y + dy - height, bottom: y + dy,
        })))
      const choice = candidates.find((candidate) => candidate.left >= view.left && candidate.right <= view.right
        && candidate.top >= view.top && candidate.bottom <= view.bottom
        && placed.every((other) => candidate.right + spacing <= other.left || candidate.left >= other.right + spacing
          || candidate.bottom + spacing <= other.top || candidate.top >= other.bottom + spacing)) ?? candidates[0]!
      placed.push(choice)
      objects.bubble.setPosition((choice.left + choice.right) / 2, choice.bottom)
      objects.bubblePlate.clear().fillStyle(0xfaf7ef, 0.97).fillRoundedRect(choice.left, choice.top + 5 * scale, width, height, 6 * scale)
      if (objects.marker.visible) objects.marker.setPosition(Math.min(view.right - objects.marker.displayWidth / 2, choice.right + objects.marker.displayWidth / 2 + 5 * scale), choice.bottom)
    }
  }

  private placeLabels(scale: number): void {
    const view = this.cameras.main.worldView
    const spacing = 6 * scale
    const placed = [...this.objects.values()].filter((objects) => objects.bubble.visible).map((objects) => ({
      left: objects.bubble.x - (objects.bubble.displayWidth + 18 * scale) / 2,
      right: objects.bubble.x + (objects.bubble.displayWidth + 18 * scale) / 2,
      top: objects.bubble.y - objects.bubble.displayHeight - 10 * scale,
      bottom: objects.bubble.y,
    }))
    for (const frame of [...this.latestFrames].sort((a, b) => Number(b.actor.selected) - Number(a.actor.selected))) {
      const objects = this.objects.get(frame.actor.id)
      if (!objects?.label.visible) continue
      const width = objects.label.displayWidth + 28 * scale
      const height = objects.label.displayHeight + 8 * scale
      const baseline = frame.position.y + 8
      const offsets = [0, 16, -16, 32, -32, 48, -48, 80, -80].map((pixels) => pixels * scale)
      const rowOffsets = [0, 1, 2, 3, 4, -1, -2].map((row) => row * (height + spacing))
      const candidates = rowOffsets.flatMap((dy) => offsets.map((dx) => ({
        left: frame.position.x + dx - width / 2, right: frame.position.x + dx + width / 2,
        top: baseline + dy, bottom: baseline + dy + height,
      })))
      const choice = candidates.find((candidate) => candidate.left >= view.left && candidate.right <= view.right
        && candidate.top >= view.top && candidate.bottom <= view.bottom
        && placed.every((other) => candidate.right + spacing <= other.left || candidate.left >= other.right + spacing
          || candidate.bottom + spacing <= other.top || candidate.top >= other.bottom + spacing)) ?? candidates[0]!
      placed.push(choice)
      objects.label.setPosition(choice.left + 19 * scale, choice.top + 4 * scale)
      const color = frame.actor.status === "attention" ? 0xe6b15b : frame.actor.status === "failed" ? 0xd77176
        : ["working", "tool", "thinking", "compacting"].includes(frame.actor.status) ? 0x49bc88 : 0x9ba9b2
      objects.labelPlate.clear().fillStyle(0x1e2934, 0.94).fillRoundedRect(choice.left, choice.top, width, height, 6 * scale)
        .fillStyle(color).fillCircle(choice.left + 10 * scale, choice.top + height / 2, 3 * scale)
    }
  }

  private paintActor(frame: ActorFrame, snapshot: OfficeSnapshot, scale: number): void {
    let objects = this.objects.get(frame.actor.id)
    if (!objects) {
      const sprite = this.add.sprite(0, 0, "characters", characterFrame(frame.appearance, frame.direction, 0))
        .setName(frame.actor.id).setOrigin(0.5, 46 / 48).setScale(1.5).setInteractive({ cursor: "var(--yc-cursor-action)" })
      sprite.on("pointerup", (pointer: Phaser.Input.Pointer) => {
        if (pointer.getDistance() < 6 && !this.latestFrames.find((item) => item.actor.id === frame.actor.id)?.leaving) this.selectSession(frame.actor.sessionID)
      })
      objects = {
        sprite,
        shadow: this.add.ellipse(0, 0, 23, 7, 0x24334a, 0.3),
        ring: this.add.ellipse(0, 0, 34, 14, 0x8fe0c6, 0.22).setStrokeStyle(2, 0x6de3b3),
        label: this.add.text(0, 0, "", { fontFamily: this.fonts.mono, fontSize: "12px", color: "#ffffff", resolution: this.resolution }).setOrigin(0, 0).setDepth(10001),
        labelPlate: this.add.graphics().setDepth(10000),
        bubble: this.add.text(0, 0, "", { fontFamily: this.fonts.sans, fontSize: "13px", color: "#253443", wordWrap: { width: 180 }, resolution: this.resolution }).setOrigin(0.5, 1).setDepth(10003),
        bubblePlate: this.add.graphics().setDepth(10002),
        marker: this.add.text(0, 0, "!", { fontFamily: this.fonts.sans, fontSize: "18px", color: "#243340", backgroundColor: "#f3be65", padding: { x: 5, y: 1 }, resolution: this.resolution }).setOrigin(0.5, 1).setDepth(10005),
      }
      this.objects.set(frame.actor.id, objects)
    }
    const x = Math.round(frame.position.x)
    const y = Math.round(frame.position.y)
    const alpha = frame.opacity * (frame.actor.source === "unavailable" ? 0.45 : frame.actor.status === "unknown" ? 0.7 : 1)
    objects.sprite.setPosition(x, y).setDepth(y).setAlpha(alpha)
    if (frame.leaving) objects.sprite.disableInteractive()
    if (!frame.leaving && !objects.sprite.input) objects.sprite.setInteractive({ cursor: "var(--yc-cursor-action)" })
    if (frame.pose === "sit" || frame.pose === "wave") {
      objects.sprite.anims.stop()
      objects.sprite.setTexture("characters", characterFrame(frame.appearance, frame.direction, characterColumns[frame.pose][0]))
    }
    if (frame.pose !== "sit" && frame.pose !== "wave") objects.sprite.play(`${frame.appearance}-${frame.direction}-${frame.pose}`, true)
    objects.shadow.setPosition(x, y + 2).setDepth(y - 1).setAlpha(alpha * 0.55)
    objects.ring.setPosition(x, y + 2).setDepth(y - 0.5).setVisible(frame.actor.selected && !frame.leaving).setAlpha(alpha)
    const preferences = this.mailbox.read().preferences
    const inView = this.cameras.main.worldView.contains(x, y)
    objects.label.setText(shortText(frame.actor.name, 20))
      .setScale(scale).setVisible(preferences.labels && !frame.leaving && inView)
    objects.labelPlate.setVisible(preferences.labels && !frame.leaving && inView)
    const bubble = frame.actor.unknownOutcome ? "Action outcome unknown" : frame.actor.bubble ?? ""
    const showBubble = !frame.leaving && inView && preferences.bubbles !== "off" && !!bubble
    objects.bubble.setText(bubble).setScale(scale).setVisible(showBubble)
    objects.bubblePlate.clear().setVisible(showBubble)
    const bubbleWidth = objects.bubble.displayWidth + 18 * scale
    const view = this.cameras.main.worldView
    const bubbleX = showBubble && view.width >= bubbleWidth + 8 * scale
      ? Phaser.Math.Clamp(x, view.left + bubbleWidth / 2 + 4 * scale, view.right - bubbleWidth / 2 - 4 * scale) : x
    objects.bubble.setPosition(bubbleX, y - objects.sprite.displayHeight - 8)
    objects.marker.setText(frame.actor.status === "failed" ? "×" : "!").setScale(scale)
    const markerX = showBubble ? Math.min(view.right - objects.marker.displayWidth / 2, bubbleX + bubbleWidth / 2 + objects.marker.displayWidth / 2 + 5 * scale) : x + 20
    objects.marker.setPosition(markerX, y - objects.sprite.displayHeight - (showBubble ? 8 : 0))
      .setVisible(!frame.leaving && inView && (frame.actor.status === "attention" || frame.actor.status === "failed" || frame.actor.unknownOutcome))
    if (snapshot.team.rootActorID === frame.actor.id) objects.ring.setStrokeStyle(2, 0x6de3b3)
  }
}
