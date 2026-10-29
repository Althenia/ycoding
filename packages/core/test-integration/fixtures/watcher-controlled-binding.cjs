const subscribes = []
const unsubscribes = []
const waiters = []

function notify() {
  for (const waiter of waiters.filter((item) => item.calls.length >= item.count)) {
    waiters.splice(waiters.indexOf(waiter), 1)
    waiter.resolve(true)
  }
}

exports.control = {
  subscribes,
  unsubscribes,
  waitFor(kind, count, ms) {
    const calls = kind === "subscribes" ? subscribes : unsubscribes
    if (calls.length >= count) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = { calls, count, resolve }
      waiters.push(waiter)
      setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index < 0) return
        waiters.splice(index, 1)
        resolve(false)
      }, ms).unref()
    })
  },
}

exports.subscribe = (dir, fn, opts) =>
  new Promise((resolve, reject) => {
    subscribes.push({ dir, fn, opts, resolve, reject })
    notify()
  })

exports.unsubscribe = (dir, fn, opts) => {
  unsubscribes.push({ dir, fn, opts })
  notify()
  return Promise.resolve()
}
