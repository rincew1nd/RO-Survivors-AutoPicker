// Trusted input replay for the RO Survivors Auto Picker.
//
// Events built with `new KeyboardEvent(...)`/`new MouseEvent(...)` and
// dispatchEvent() are always marked `isTrusted: false`, and that flag is
// unforgeable from script. The only in-browser way to produce real input is
// to drive the browser's own input pipeline, which is what the DevTools
// protocol's Input domain does. A background page is the only place
// chrome.debugger exists, so the content script asks this worker to press
// keys, click screen points and invoke page button handlers. This is the only
// path the add-on uses to play the game.
//
// If the API is missing (Firefox) or the tab already has a debugger on it
// (DevTools open, another extension), the worker answers ok: false and the
// action is dropped. No synthetic key or pointer event is dispatched as a
// fallback; only a button with no onclick handler is activated with click().

const PROTOCOL_VERSION = "1.3";
// Shown in the service worker console and in every reply, so it is obvious
// which build is loaded and whether an old worker is still answering.
const BUILD = chrome.runtime.getManifest?.().version ?? "unknown";
console.log(`[roa-input] build ${BUILD} loaded`);
// Last events, readable from the service worker console
// (chrome://extensions -> Inspect) while a message is stuck.
const state = { build: BUILD, message: null, call: null, last: null, reply: null };
globalThis.__roaInput = state;
// A debugger callback that never comes back must not hold the message port
// open. Every call has a deadline, and the answer says it timed out.
const CALL_TIMEOUT_MS = 3000;
const attachedTabs = new Set();
// chrome.debugger calls are serialised so a keyup can never overtake the
// keydown it belongs to.
let chain = Promise.resolve();

const describeKey = (key) => {
  const lower = String(key ?? "").toLowerCase();
  if (/^[a-z]$/.test(lower)) {
    return { code: `Key${lower.toUpperCase()}`, vk: lower.toUpperCase().charCodeAt(0) };
  }
  if (/^[0-9]$/.test(lower)) {
    return { code: `Digit${lower}`, vk: lower.charCodeAt(0) };
  }
  if (lower === " ") return { code: "Space", vk: 32 };
  if (lower === "escape") return { code: "Escape", vk: 27 };
  if (lower === "enter") return { code: "Enter", vk: 13 };
  const arrows = {
    arrowup: { code: "ArrowUp", vk: 38 },
    arrowdown: { code: "ArrowDown", vk: 40 },
    arrowleft: { code: "ArrowLeft", vk: 37 },
    arrowright: { code: "ArrowRight", vk: 39 },
  };
  return arrows[lower] ?? null;
};

// Run one chrome.debugger call as a promise. Reading chrome.runtime.lastError
// inside the callback is mandatory; a synchronous throw and a callback that
// never arrives are both turned into a rejection.
const call = (label, run) => {
  const started = Date.now();
  state.call = { label, started };
  console.log(`[roa-input] ${label} start`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.call = null;
      state.last = { label, ok: false, ms: Date.now() - started, reason: "timeout" };
      console.warn(`[roa-input] ${label} timed out after ${Date.now() - started}ms`);
      reject(new Error(`${label} timed out`));
    }, CALL_TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.call = null;
      const lastError = chrome.runtime.lastError;
      const reason = error?.message ?? lastError?.message;
      state.last = {
        label,
        ok: !error && !lastError,
        ms: Date.now() - started,
        reason: reason ?? null,
      };
      if (error || lastError) {
        console.warn(
          `[roa-input] ${label} failed after ${Date.now() - started}ms:`,
          reason ?? "debugger failed",
        );
        reject(new Error(String(reason ?? "debugger failed")));
        return;
      }
      console.log(`[roa-input] ${label} ok in ${Date.now() - started}ms`);
      resolve();
    };
    try {
      run(finish);
    } catch (error) {
      finish(error);
    }
  });
};

const attach = async (tabId) => {
  if (attachedTabs.has(tabId)) return;
  console.log(`[roa-input] attaching to tab ${tabId}`);
  await call("attach", (done) =>
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => done()),
  );
  attachedTabs.add(tabId);
};

// A failed command does not mean the debugger was dropped. Forgetting the tab
// without detaching makes every later attach fail with "Another debugger is
// already attached", so detach explicitly before dropping the bookkeeping.
// It never rejects: the caller is already sending the original error back.
const detach = (tabId) =>
  call("detach", (done) => chrome.debugger.detach({ tabId }, () => done()))
    .catch(() => {})
    .then(() => {
      console.log(`[roa-input] detached from tab ${tabId}`);
      attachedTabs.delete(tabId);
    });

const press = (tabId, action, key) => {
  const info = describeKey(key);
  if (!info) return Promise.reject(new Error(`unsupported key: ${key}`));
  const params = {
    // rawKeyDown skips the character/text stage: the game listens for
    // keydown only, and this avoids typing into a focused input.
    type: action === "keyup" ? "keyUp" : "rawKeyDown",
    key: String(key),
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    autoRepeat: false,
    isKeypad: false,
    location: 0,
  };
  return call("key", (done) =>
    chrome.debugger.sendCommand(
      { tabId },
      "Input.dispatchKeyEvent",
      params,
      () => done(),
    ),
  );
};

const sendMouse = (tabId, params) => {
  console.log(
    `[roa-input] mouse ${params.type} at ${params.x},${params.y} buttons=${params.buttons}`,
  );
  return call("mouse", (done) =>
    chrome.debugger.sendCommand(
      { tabId },
      "Input.dispatchMouseEvent",
      params,
      () => done(),
    ),
  );
};

// A left-button click at viewport CSS coordinates. Press and release are sent
// as one serialised pair so a second click can never land between them.
const click = async (tabId, x, y) => {
  const base = { x, y, button: "left", clickCount: 1 };
  await sendMouse(tabId, { type: "mousePressed", ...base, buttons: 1 });
  await sendMouse(tabId, { type: "mouseReleased", ...base, buttons: 0 });
};

// Buttons are invoked in the page through Runtime.evaluate. Input events do
// not reach a background window, and a focused button's default click action
// does not run there either, so the game's own handler is called instead.
// Card picks still go through trusted number keys.
const invoke = (tabId, selector) => {
  if (typeof selector !== "string" || !selector) {
    return Promise.reject(new Error("bad selector"));
  }
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || !el.isConnected) return false;
    const ev = {
      stopPropagation() {},
      stopImmediatePropagation() {},
      preventDefault() {},
      target: el,
      currentTarget: el,
    };
    const fire = (node) => {
      if (typeof node.onclick !== "function") return false;
      node.onclick(ev);
      return true;
    };
    if (fire(el)) return true;
    const box = el.closest("#drop-reveal");
    if (box && fire(box)) return true;
    // A handler attached with addEventListener is invisible here; click()
    // runs every listener regardless of how it was registered.
    if (typeof el.click === "function") {
      el.click();
      return true;
    }
    return false;
  })()`;
  return call("evaluate", (done) =>
    chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      { expression, returnByValue: true, userGesture: true },
      (result) => {
        if (chrome.runtime.lastError) {
          done(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (result?.exceptionDetails) {
          done(new Error(result.exceptionDetails.text || "evaluate failed"));
          return;
        }
        if (result?.result?.value === false) {
          done(new Error("element or handler not found"));
          return;
        }
        done();
      },
    ),
  );
};

const respond = (sendResponse, payload) => {
  try {
    sendResponse(payload);
  } catch {
    // The content script navigated away while the command was in flight.
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  const detail =
    message.type === "trusted-invoke"
      ? message.selector
      : message.type === "trusted-click"
        ? `${message.x},${message.y}`
        : message.type === "trusted-key"
          ? `${message.action}:${message.key}`
          : "";
  state.message = { type: message.type ?? "?", detail, at: Date.now() };
  console.log(`[roa-input] message ${message.type ?? "?"} ${detail}`);
  if (message.type === "trusted-ping") {
    // A cheap answer so the content script can tell whether this worker is
    // the current build and reachable after Chrome unloaded it.
    console.log("[roa-input] ping");
    respond(sendResponse, { ok: true, build: BUILD });
    return false;
  }
  const isKey = message.type === "trusted-key";
  const isClick = message.type === "trusted-click";
  const isInvoke = message.type === "trusted-invoke";
  if (!isKey && !isClick && !isInvoke) {
    console.warn(`[roa-input] ignored unknown message ${message.type ?? "?"}`);
    return false;
  }
  const tabId = sender.tab?.id;
  if (tabId == null || typeof chrome.debugger === "undefined") {
    console.warn("[roa-input] no tab or no debugger API", tabId);
    sendResponse({ ok: false, reason: "unsupported", build: BUILD });
    return false;
  }
  const action = message.action === "keyup" ? "keyup" : "keydown";
  const key = String(message.key ?? "");
  const x = Number(message.x);
  const y = Number(message.y);
  const handle = async () => {
    try {
      await attach(tabId);
      if (isInvoke) {
        await invoke(tabId, message.selector);
      } else if (isClick) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("bad click coordinates");
        }
        await click(tabId, x, y);
      } else {
        await press(tabId, action, key);
      }
      console.log(`[roa-input] reply ok ${message.type}`);
      state.reply = { type: message.type, ok: true, at: Date.now() };
      respond(sendResponse, { ok: true, build: BUILD });
    } catch (error) {
      console.warn(`[roa-input] reply failed ${message.type}:`, error?.message ?? error);
      state.reply = {
        type: message.type,
        ok: false,
        reason: String(error?.message ?? error),
        at: Date.now(),
      };
      await detach(tabId);
      respond(sendResponse, {
        ok: false,
        reason: String(error?.message ?? error),
        build: BUILD,
      });
    }
  };
  // Run even if the previous link failed, and never leave the chain rejected:
  // one stuck command must not silence every action after it.
  chain = chain.then(handle, handle).catch(() => {});
  return true;
});

chrome.debugger?.onDetach.addListener((source) => {
  if (source.tabId != null) {
    console.warn(`[roa-input] debugger detached from tab ${source.tabId}`, source.reason);
    attachedTabs.delete(source.tabId);
  }
});

chrome.tabs?.onRemoved.addListener((tabId) => {
  console.log(`[roa-input] tab ${tabId} removed`);
  attachedTabs.delete(tabId);
});
