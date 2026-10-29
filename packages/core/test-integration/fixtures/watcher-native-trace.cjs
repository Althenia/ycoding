const { writeSync } = require("node:fs")

const binding = require(process.env.YCODING_TEST_REAL_PARCEL_WATCHER)
const counts = {
  subscribeInvoked: 0,
  subscribeResolved: 0,
  subscribeRejected: 0,
  unsubscribeInvoked: 0,
  unsubscribeResolved: 0,
  unsubscribeRejected: 0,
}

function record(operation, stage) {
  counts[operation + stage[0].toUpperCase() + stage.slice(1)]++
  const bytes = Buffer.from(JSON.stringify({ event: "native", operation, stage, counts: { ...counts } }) + "\n")
  let offset = 0
  while (offset < bytes.length) offset += writeSync(3, bytes, offset)
}

function trace(operation) {
  const original = binding[operation]
  return function (...args) {
    record(operation, "invoked")
    const promise = Reflect.apply(original, binding, args)
    promise.then(
      () => record(operation, "resolved"),
      () => record(operation, "rejected"),
    )
    return promise
  }
}

module.exports = Object.assign(Object.create(binding), {
  subscribe: trace("subscribe"),
  unsubscribe: trace("unsubscribe"),
})
