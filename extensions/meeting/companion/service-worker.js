import { createCoordinator } from "./coordinator.js"

const coordinator = createCoordinator({
  chrome,
  fetch: (input, init) => fetch(input, init),
  sendOffscreen: (message) => chrome.runtime.sendMessage(message),
})
const ready = coordinator.initialize()
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target === "offscreen") return false
  void ready.then(() => coordinator.handle(message, sender)).then(reply, (error) => reply({ error: error.message }))
  return true
})
chrome.tabs.onRemoved.addListener((tabID) => {
  void ready.then(() => coordinator.tabRemoved(tabID))
})
chrome.tabs.onUpdated.addListener((tabID, change) => {
  void ready.then(() => coordinator.tabUpdated(tabID, change))
})
chrome.permissions.onRemoved.addListener(() => {
  void ready.then(() => coordinator.permissionsRemoved())
})
chrome.tabCapture.onStatusChanged.addListener((info) => {
  void ready.then(() => coordinator.captureChanged(info))
})
chrome.commands.onCommand.addListener((command) => {
  if (command === "stop-capture") void ready.then(() => coordinator.stop("keyboard"))
})
