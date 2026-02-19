import fs from 'fs/promises'

const events = {}

export function hook(eventName, ...args) {
    eventName = eventName.toLowerCase()
    if (!events?.[eventName]) return false
    for (const eventIndex in events[eventName]) {
		const event = events[eventName][eventIndex]
        
        event.callback(...args)
        
        if (event.once == true) events[eventName].splice(eventIndex, 1)
    }
    return true
}

export function on(eventName, cb, options) {
    eventName = eventName.toLowerCase()
    if (!events?.[eventName]) events[eventName] = []
    
    return events[eventName].push({
        callback: cb,
        ...options
    })
}

export function remove(eventName, id) {
    eventName = eventName.toLowerCase()
    if (!events?.[eventName] || !events?.[eventName]?.[id]) return false
    events[eventName].splice(id, 1)
    return true
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function init() {
    if (await exists("./plugins")) {
        for (const content of await fs.readdir("./plugins", { withFileTypes: true })) {
            await import("./plugins/" + content.name)
        }
        hook("plugins-loaded")
    }
}

init()

export default {
    remove,
    on,
    hook
}