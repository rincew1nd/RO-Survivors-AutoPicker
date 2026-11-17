/*
 * RO Survivors Auto Picker - content script.
 *
 * Reads the level-up / chest card picker of RO Survivors and clicks the card
 * your build ranks highest. Also: party loot rolls, auto-move, inventory
 * search, and saved talent / equipment sets.
 *
 * Layout of this file
 *   1. Core         helpers, storage, options
 *   2. Model        skills, items, builds, loot rules, detected cards
 *   3. Cards        reading a card from the page and working out what it is
 *   4. Decisions    scoring cards and choosing what to do with an offer
 *   5. Picker       the loop that watches the picker and acts on it
 *   6. Movement     auto-move and party loot rolls
 *   7. Interface    settings triggers, notes, dialogs, run prompt
 *   8. Settings     the settings panel
 *   9. Game tools   inventory search, talent sets, equipment sets
 *  10. Start-up     run tracking, hotkeys, scheduler
 *
 * The game tables live in data.js. Everything is saved in the page's
 * localStorage under "ro-auto-*" keys, so settings survive extension updates.
 */
(() => {
  "use strict";

  const root = document.documentElement;
  const DATA = globalThis.RO_AUTO_DATA;
  // Same marker as 1.x, so two copies of the extension never run together.
  if (!root || !DATA || root.dataset.roAutoPicker) return;

  const OFFICIAL_HOST = /(?:^|\.)ro-survivors\.com$/i.test(location.hostname);

  function main() {
    // =====================================================================
    // 1. Core
    // =====================================================================
    const {
      SKILLS,
      ITEMS,
      ITEM_STATS,
      MAIN_STAT,
      LOADOUTS,
      CLASS_ICON,
      CLASS_HUD,
      RARITY,
      STAT_LABELS,
      ITEM_STAT_LABELS,
      SKILL_ASPECTS,
      SKILL_TYPES,
      AUTO_SKILL,
      AUTO_ASPECTS,
      QUALITY_NAMES,
      CARDS = [],
    } = DATA;

    const APP_ID = "ro-survivors-autopick";
    let VERSION = "4.2.0";
    try {
      VERSION = chrome.runtime.getManifest().version || VERSION;
    } catch {}

    const $ = (selector, scope) => (scope || document).querySelector(selector);
    const $$ = (selector, scope) =>
      Array.from((scope || document).querySelectorAll(selector));
    // Text of `el`, or of the first match of `selector` inside it.
    const text = (el, selector) => {
      const node = selector ? el?.querySelector(selector) : el;
      return (node?.textContent || "").trim();
    };
    const lower = (value) => String(value ?? "").toLowerCase();
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const nowMs = () => Date.now();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Poll `probe` until it returns something truthy or `timeout` ms pass.
    const waitFor = async (probe, timeout = 400, step = 15) => {
      const end = nowMs() + timeout;
      for (;;) {
        let value = null;
        try {
          value = probe();
        } catch {
          value = null;
        }
        if (value) return value;
        if (nowMs() >= end) return null;
        await sleep(step);
      }
    };
    const esc = (value) =>
      String(value ?? "").replace(
        /[&<>"']/g,
        (ch) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[ch],
      );
    const shortId = () => Math.random().toString(36).slice(2, 9);
    const newRowId = () => "r" + shortId() + Date.now().toString(36);
    const jobLabel = (job) => (job ? job[0].toUpperCase() + job.slice(1) : "");
    const isTypingTarget = (target) =>
      !!target &&
      (/^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "") ||
        !!target.isContentEditable);

    // Problems are counted here and shown on the Activity tab; nothing in
    // this script is allowed to throw into the page or spam the console.
    const DIAG_KEY = "ro-auto-diagnostics";
    const readDiag = () => {
      try {
        const raw = JSON.parse(sessionStorage.getItem(DIAG_KEY) || "null");
        const errors = new Map();
        if (Array.isArray(raw?.errors)) {
          for (const pair of raw.errors) {
            if (!Array.isArray(pair) || !pair[0] || !pair[1]) continue;
            errors.set(String(pair[0]), {
              count: Math.max(0, Number(pair[1].count) || 0),
              message: String(pair[1].message || ""),
              at: Math.max(0, Number(pair[1].at) || 0),
            });
          }
        }
        return { total: Math.max(0, Number(raw?.total) || 0), errors };
      } catch {
        return { total: 0, errors: new Map() };
      }
    };
    const diag = readDiag();
    const saveDiag = () => {
      try {
        sessionStorage.setItem(
          DIAG_KEY,
          JSON.stringify({ total: diag.total, errors: [...diag.errors] }),
        );
      } catch {}
    };
    const noteError = (label, error) => {
      diag.total += 1;
      const entry = diag.errors.get(label) || { count: 0, message: "", at: 0 };
      entry.count += 1;
      entry.message = String(error?.message || error || "unknown error");
      entry.at = nowMs();
      diag.errors.set(label, entry);
      saveDiag();
    };
    const guard =
      (label, fn) =>
      (...args) => {
        try {
          return fn(...args);
        } catch (error) {
          noteError(label, error);
          return undefined;
        }
      };
    const guardAsync =
      (label, fn) =>
      async (...args) => {
        try {
          return await fn(...args);
        } catch (error) {
          noteError(label, error);
          return undefined;
        }
      };

    // ---------------------------------------------------------- storage --
    const KEYS = {
      enabled: "ro-auto-enabled",
      move: "ro-auto-move",
      priority: "ro-auto-priority-enabled",
      pickupOn: "ro-auto-pickup-enabled",
      builds: "ro-auto-builds",
      legacy: "ro-auto-custom",
      settingsClass: "ro-auto-settings-class",
      pickup: "ro-auto-pickup",
      skillBuilds: "ro-auto-skill-builds",
      equipBuilds: "ro-auto-equip-builds",
      options: "ro-auto-options",
      learned: "ro-auto-learned",
      gameData: "ro-auto-gamedata",
    };
    const DATA_KEYS = Object.values(KEYS);
    const JSON_KEYS = new Set([
      KEYS.builds,
      KEYS.legacy,
      KEYS.pickup,
      KEYS.skillBuilds,
      KEYS.equipBuilds,
      KEYS.options,
      KEYS.learned,
      KEYS.gameData,
    ]);

    const ls = {
      get(key) {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(key, value);
          return true;
        } catch {
          return false;
        }
      },
      remove(key) {
        try {
          localStorage.removeItem(key);
        } catch {}
      },
      json(key, fallback) {
        const raw = this.get(key);
        if (raw == null) return fallback;
        try {
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
    };

    // A second copy of everything is kept in the extension's own storage, so
    // builds come back if the site's data is ever cleared.
    const mirrorSlot = OFFICIAL_HOST
      ? "ro-auto-backup:game"
      : `ro-auto-backup:${location.origin}`;
    let mirrorTimer = 0;
    let mirrorSavedAt = 0;
    const extStorage = () => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime?.id) return null;
        return chrome.storage?.local ?? null;
      } catch {
        return null;
      }
    };
    const snapshotKeys = () => {
      const out = {};
      for (const key of DATA_KEYS) {
        const value = ls.get(key);
        if (value != null) out[key] = value;
      }
      return out;
    };
    const writeMirror = () => {
      mirrorTimer = 0;
      const area = extStorage();
      if (!area) return;
      const keys = snapshotKeys();
      if (typeof keys[KEYS.builds] !== "string") return;
      try {
        const done = area.set({
          [mirrorSlot]: { savedAt: nowMs(), origin: location.origin, keys },
        });
        if (done && typeof done.then === "function") {
          done.then(
            () => {
              mirrorSavedAt = nowMs();
            },
            () => {},
          );
        }
      } catch {}
    };
    const scheduleMirror = () => {
      if (!mirrorTimer) mirrorTimer = setTimeout(writeMirror, 1500);
    };
    const readMirror = () =>
      new Promise((resolve) => {
        const area = extStorage();
        if (!area) {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        setTimeout(() => finish(null), 1200);
        try {
          const pending = area.get(mirrorSlot);
          if (pending && typeof pending.then === "function") {
            pending.then(
              (items) => finish(items?.[mirrorSlot] ?? null),
              () => finish(null),
            );
          } else {
            finish(null);
          }
        } catch {
          finish(null);
        }
      });
    const clearMirror = () => {
      const area = extStorage();
      if (!area) return;
      try {
        const pending = area.remove(mirrorSlot);
        if (pending && typeof pending.then === "function") {
          pending.then(
            () => {},
            () => {},
          );
        }
      } catch {}
      mirrorSavedAt = 0;
    };
    // Only when the page has none of our keys at all: a fresh profile, or
    // site data that was wiped.
    const restoreFromMirrorIfEmpty = async () => {
      let hasAny;
      try {
        hasAny = DATA_KEYS.some((key) => localStorage.getItem(key) != null);
      } catch {
        return 0;
      }
      if (hasAny) return 0;
      const backup = await readMirror();
      const keys = backup?.keys;
      if (!keys || typeof keys !== "object") return 0;
      if (typeof keys[KEYS.builds] !== "string") return 0;
      for (const key of DATA_KEYS) {
        if (typeof keys[key] === "string") ls.set(key, keys[key]);
      }
      return Number(backup.savedAt) || 1;
    };

    // Writes are batched: typing in a field must not re-serialise every
    // build on each keystroke.
    const pendingSaves = new Map();
    let saveTimer = 0;
    const flushSaves = () => {
      clearTimeout(saveTimer);
      saveTimer = 0;
      if (!pendingSaves.size) return;
      for (const [key, produce] of pendingSaves) {
        let value = null;
        try {
          value = produce();
        } catch (error) {
          noteError("save", error);
        }
        if (typeof value === "string") ls.set(key, value);
      }
      pendingSaves.clear();
      scheduleMirror();
    };
    const queueSave = (key, produce) => {
      pendingSaves.set(key, produce);
      if (!saveTimer) saveTimer = setTimeout(flushSaves, 250);
    };
    const saveNow = (key, value) => {
      pendingSaves.delete(key);
      ls.set(key, value);
      scheduleMirror();
    };

    // ------------------------------------------------------------ flags --
    let enabled = true;
    let autoMove = true;
    let priorityEnabled = true;
    let pickupEnabled = true;
    const loadFlags = () => {
      enabled = ls.get(KEYS.enabled) !== "0";
      autoMove = ls.get(KEYS.move) !== "0";
      priorityEnabled = ls.get(KEYS.priority) !== "0";
      pickupEnabled = ls.get(KEYS.pickupOn) !== "0";
    };

    // ---------------------------------------------------------- options --
    const MOVE_PATTERNS = {
      circle: "Circle",
      random: "Random",
      zigzag: "Back and forth",
    };
    const MOVE_PACES = { 800: "Fast", 1600: "Normal", 2400: "Slow" };
    const defaultOptions = () => ({
      suggestOnly: false,
      askBuild: true,
      toasts: true,
      manualSound: false,
      keepActive: true,
      randomAfterRerolls: false,
      titleGear: true,
      bodyButton: true,
      move: {
        pattern: "circle",
        step: 20,
        interval: 1600,
        wasd: false,
        yieldToManual: true,
        onlyInRun: false,
        collectChests: true,
        collectMagnets: true,
        collectItems: false,
        itemRarity: 2,
      },
    });
    const normalizeOptions = (raw) => {
      const base = defaultOptions();
      if (!raw || typeof raw !== "object") return base;
      for (const key of ["suggestOnly", "askBuild", "toasts", "manualSound", "keepActive", "randomAfterRerolls", "titleGear", "bodyButton"]) {
        if (typeof raw[key] === "boolean") base[key] = raw[key];
      }
      const move = raw.move && typeof raw.move === "object" ? raw.move : {};
      if (Object.hasOwn(MOVE_PATTERNS, move.pattern)) {
        base.move.pattern = move.pattern;
      }
      // 2.6.0 and older stored the step as a fraction of the screen.
      const step = Number(move.step);
      if (Number.isFinite(step) && step > 0) {
        base.move.step = clamp(Math.round(step), 1, 500);
      } else if (Number.isFinite(move.radius)) {
        base.move.step =
          move.radius <= 0.22 ? 10 : move.radius <= 0.34 ? 20 : 30;
      }
      if (Number.isFinite(move.interval)) {
        base.move.interval = clamp(Math.round(move.interval), 400, 5000);
      }
      if (Number.isFinite(move.itemRarity)) {
        base.move.itemRarity = clamp(Math.round(move.itemRarity), 1, 4);
      }
      for (const key of [
        "wasd",
        "yieldToManual",
        "onlyInRun",
        "collectChests",
        "collectMagnets",
        "collectItems",
      ]) {
        if (typeof move[key] === "boolean") base.move[key] = move[key];
      }
      return base;
    };
    let opts = defaultOptions();
    const saveOptions = () => saveNow(KEYS.options, JSON.stringify(opts));

    // ------------------------------------------------------ activity log --
    const MAX_ACTIVITY = 80;
    const ACTIVITY_KEY = "ro-auto-activity";
    const readActivity = () => {
      try {
        const raw = JSON.parse(sessionStorage.getItem(ACTIVITY_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw
          .filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.message === "string",
          )
          .slice(-MAX_ACTIVITY);
      } catch {
        return [];
      }
    };
    const activity = readActivity();
    const saveActivity = () => {
      try {
        sessionStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
      } catch {}
    };
    const emptyRunStats = () => ({
      picks: 0,
      manualPicks: 0,
      rerolls: 0,
      cardRerolls: 0,
      focus: 0,
      banish: 0,
      waits: 0,
      need: 0,
      greed: 0,
      pass: 0,
    });
    let runStats = emptyRunStats();

    // =====================================================================
    // 2. Model
    // =====================================================================
    const skillByIcon = new Map();
    const skillByName = new Map();
    const skillById = new Map();
    const itemById = new Map();
    for (const [job, list] of Object.entries(SKILLS)) {
      list.forEach((entry, index) => {
        entry.cls = job;
        entry.baseRank = index;
        skillByIcon.set(entry.icon, entry);
        skillById.set(entry.id, entry);
        for (const name of entry.names) skillByName.set(lower(name), entry);
      });
    }
    for (const list of Object.values(ITEMS)) {
      for (const entry of list) {
        entry.stats = ITEM_STATS[entry.id] ?? entry.stats ?? [];
        if (!itemById.has(entry.id)) itemById.set(entry.id, entry);
      }
    }
    skillById.set(AUTO_SKILL.id, AUTO_SKILL);
    for (const name of AUTO_SKILL.names) {
      skillByName.set(lower(name), AUTO_SKILL);
    }

    // ---------------------------------------------------- detected cards --
    // Cards the tables do not know are remembered once they show up in the
    // picker, so they can be added to a build. Until a build uses one, it is
    // still scored as an unknown card, exactly as before.
    const SAFE_ID = /^[a-z0-9_]{1,64}$/;
    const SLOT_TYPES = ["deity", "potion", "elixir", "blessing", "dish"];
    const learnedSkills = {};
    const learnedItems = [];
    const liveSkillMeta = new Map();
    const liveSkillByIcon = new Map();
    const skillSummaryCache = new Map();
    let learnedRevision = 0;
    const classItemsCache = new Map();
    const itemTablesCache = new Map();
    const deityCache = new Map();
    const dropItemCaches = () => {
      classItemsCache.clear();
      itemTablesCache.clear();
    };
    // Live registry loaded from the game's own module (see gamedata.js).
    let gameDataSignature = "";
    let gameDataInfo = null;
    let gameDataSeen = false;
    const cleanStats = (stats) =>
      Array.isArray(stats)
        ? [
            ...new Set(
              stats.filter(
                (key) =>
                  typeof key === "string" &&
                  key !== "any" &&
                  Object.hasOwn(STAT_LABELS, key),
              ),
            ),
          ]
        : [];
    const skillAspects = (raw, existing) => {
      const keys = Array.isArray(raw?.aspects) ? raw.aspects : [];
      const valid = (key) =>
        key === "effect" || Object.hasOwn(STAT_LABELS, key);
      const live = [...new Set(keys.filter(valid))];
      if (live.length) return live;
      return [
        ...new Set(
          [...(SKILL_ASPECTS[raw?.type] ?? []), ...(existing ?? [])].filter(
            valid,
          ),
        ),
      ];
    };

    const registerLearnedSkill = (job, raw) => {
      if (!SKILLS[job] || !raw || typeof raw !== "object") return null;
      const rawId = typeof raw.id === "string" ? raw.id : "";
      const rawIcon = typeof raw.icon === "string" && raw.icon ? raw.icon : rawId;
      const meta = liveSkillMeta.get(rawId) ?? liveSkillByIcon.get(rawIcon);
      const id = meta?.id ?? rawId;
      const icon = meta?.icon ?? rawIcon;
      if (!SAFE_ID.test(id) || !SAFE_ID.test(icon)) return null;
      if (skillById.has(id) || skillByIcon.has(icon)) return null;
      const aspects = skillAspects(meta ?? raw, cleanStats(raw.stats));
      const list = (learnedSkills[job] ??= []);
      const entry = {
        id,
        icon,
        names: [String(meta?.name || raw.name || id).slice(0, 80)],
        stats: aspects.length ? aspects : cleanStats(raw.stats),
        aspects,
        type: meta?.type || raw.type || "",
        countTarget: meta?.countTarget === true,
        countUnit: meta?.countUnit || "",
        cls: job,
        baseRank: SKILLS[job].length + list.length,
        learned: true,
      };
      if (entry.type) SKILL_TYPES[id] = entry.type;
      list.push(entry);
      skillById.set(id, entry);
      skillByIcon.set(icon, entry);
      const key = lower(entry.names[0]);
      if (!skillByName.has(key)) skillByName.set(key, entry);
      learnedRevision += 1;
      return entry;
    };

    const registerLearnedItem = (raw) => {
      if (!raw || typeof raw !== "object") return null;
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!SAFE_ID.test(id)) return null;
      const jobs = Array.isArray(raw.jobs)
        ? raw.jobs.filter((job) => !!SKILLS[job])
        : [];
      const existing = learnedItems.find((entry) => entry.id === id);
      if (existing) {
        if (existing.jobs) {
          const merged = jobs.length
            ? [...new Set([...existing.jobs, ...jobs])]
            : null;
          if (!merged || merged.length !== existing.jobs.length) {
            existing.jobs = merged;
            learnedRevision += 1;
            dropItemCaches();
          }
        }
        return existing;
      }
      const base = itemById.get(id);
      const entry = {
        id,
        names: base ? [...base.names] : [String(raw.name || id).slice(0, 80)],
        ownStats: cleanStats(raw.stats),
        stats: [],
        learned: true,
        jobs: jobs.length ? jobs : null,
      };
      entry.stats = ITEM_STATS[id] ?? entry.ownStats;
      const run = base?.run ?? raw.run;
      if (typeof run === "string" && SAFE_ID.test(run)) entry.run = run;
      const icon = base?.icon ?? raw.icon;
      if (icon != null && SAFE_ID.test(String(icon))) entry.icon = String(icon);
      if (SLOT_TYPES.includes(raw.slot)) entry.slot = raw.slot;
      if (!entry.run && !entry.icon) return null;
      learnedItems.push(entry);
      if (!base) itemById.set(id, entry);
      learnedRevision += 1;
      dropItemCaches();
      return entry;
    };

    const forgetLearned = () => {
      for (const list of Object.values(learnedSkills)) {
        for (const entry of list) {
          if (skillById.get(entry.id) === entry) skillById.delete(entry.id);
          if (skillByIcon.get(entry.icon) === entry) {
            skillByIcon.delete(entry.icon);
          }
          const key = lower(entry.names[0]);
          if (skillByName.get(key) === entry) skillByName.delete(key);
        }
      }
      for (const job of Object.keys(learnedSkills)) delete learnedSkills[job];
      for (const entry of learnedItems) {
        if (itemById.get(entry.id) === entry) itemById.delete(entry.id);
      }
      learnedItems.length = 0;
      deityCache.clear();
      dropItemCaches();
    };
    const learnedCount = () =>
      learnedItems.length +
      Object.values(learnedSkills).reduce((sum, list) => sum + list.length, 0);
    const learnedPayload = () => ({
      skills: Object.fromEntries(
        Object.entries(learnedSkills).map(([job, list]) => [
          job,
          list.map((entry) => ({
            id: entry.id,
            icon: entry.icon,
            name: entry.names[0],
            stats: entry.stats,
          })),
        ]),
      ),
      items: learnedItems.map((entry) => ({
        id: entry.id,
        run: entry.run,
        icon: entry.icon,
        name: entry.names[0],
        slot: entry.slot,
        stats: entry.ownStats,
        jobs: entry.jobs,
      })),
    });
    const saveLearned = () =>
      queueSave(KEYS.learned, () => JSON.stringify(learnedPayload()));
    const loadLearned = () => {
      forgetLearned();
      const raw = ls.json(KEYS.learned, null);
      if (!raw || typeof raw !== "object") return;
      if (raw.skills && typeof raw.skills === "object") {
        for (const [job, list] of Object.entries(raw.skills)) {
          if (!Array.isArray(list)) continue;
          for (const item of list) registerLearnedSkill(job, item);
        }
      }
      if (Array.isArray(raw.items)) {
        for (const item of raw.items) registerLearnedItem(item);
      }
    };

    // ------------------------------------------------------ live game data --
    // gamedata.js (MAIN world) reads the game's own module and posts its
    // registry here. data.js remains the fallback seed if that never arrives.
    const GAMEDATA_VERSION = 2;
    const rebuildSkillIndex = () => {
      skillByIcon.clear();
      skillByName.clear();
      skillById.clear();
      for (const [job, list] of Object.entries(SKILLS)) {
        list.forEach((entry, index) => {
          entry.cls = job;
          entry.baseRank = index;
          if (entry.icon) skillByIcon.set(entry.icon, entry);
          skillById.set(entry.id, entry);
          for (const name of entry.names ?? []) {
            skillByName.set(lower(name), entry);
          }
        });
      }
      for (const list of Object.values(learnedSkills)) {
        for (const entry of list) {
          if (entry.icon) skillByIcon.set(entry.icon, entry);
          skillById.set(entry.id, entry);
          for (const name of entry.names ?? []) skillByName.set(lower(name), entry);
        }
      }
      skillById.set(AUTO_SKILL.id, AUTO_SKILL);
      for (const name of AUTO_SKILL.names) {
        skillByName.set(lower(name), AUTO_SKILL);
      }
    };
    const rebuildItemIndex = () => {
      itemById.clear();
      for (const list of Object.values(ITEMS)) {
        for (const entry of list) {
          entry.stats = ITEM_STATS[entry.id] ?? entry.stats ?? [];
          if (!itemById.has(entry.id)) itemById.set(entry.id, entry);
        }
      }
      for (const entry of learnedItems) {
        if (!itemById.has(entry.id)) itemById.set(entry.id, entry);
      }
    };
    const mergeItemData = (entry, raw) => {
      if (raw.stats.length) {
        entry.stats = [...raw.stats];
        ITEM_STATS[entry.id] = entry.stats;
      } else {
        entry.stats = ITEM_STATS[entry.id] ?? entry.stats ?? [];
      }
      if (raw.slot) entry.slot = raw.slot;
      if (raw.icon) entry.icon = raw.icon;
      if (raw.run) entry.run = raw.run;
      for (const name of raw.names) {
        if (!entry.names.includes(name)) entry.names.push(name);
      }
    };
    const applyGameData = (payload) => {
      if (!payload || payload.v !== GAMEDATA_VERSION) return null;
      const skillsRaw = Array.isArray(payload.skills)
        ? payload.skills.slice(0, 2000)
        : [];
      const itemsRaw = Array.isArray(payload.items)
        ? payload.items.slice(0, 2000)
        : [];
      if (skillsRaw.length < 5 || itemsRaw.length < 5) return null;
      const skillData = new Map();
      liveSkillMeta.clear();
      liveSkillByIcon.clear();
      for (const raw of skillsRaw) {
        if (!raw || typeof raw.id !== "string" || !SAFE_ID.test(raw.id)) continue;
        skillData.set(raw.id, raw);
        const type = typeof raw.type === "string" ? raw.type : "";
        if (type) SKILL_TYPES[raw.id] = type;
        const meta = {
          id: raw.id,
          name: typeof raw.name === "string" ? raw.name : raw.id,
          icon: typeof raw.icon === "string" ? raw.icon : "",
          type,
          kind: typeof raw.kind === "string" ? raw.kind : "",
          aspects: skillAspects(raw),
          countTarget: raw.countTarget === true,
          countUnit: typeof raw.countUnit === "string" ? raw.countUnit : "",
        };
        liveSkillMeta.set(raw.id, meta);
        if (meta.icon) liveSkillByIcon.set(meta.icon, meta);
      }
      if (skillData.size < 5) return null;
      const jobs =
        payload.jobs && typeof payload.jobs === "object" ? payload.jobs : {};
      // Keep the seed translations even when the live name replaces the
      // displayed one, so name-only identification still works per locale.
      const seedNames = new Map();
      for (const list of Object.values(SKILLS)) {
        for (const entry of list) {
          if (!seedNames.has(entry.id)) seedNames.set(entry.id, entry.names ?? []);
        }
      }
      for (const [job, ids] of Object.entries(jobs)) {
        if (!Object.hasOwn(SKILLS, job) || !Array.isArray(ids)) continue;
        const list = [];
        for (const id of ids) {
          const raw = skillData.get(id);
          if (!raw) continue;
          const type = typeof raw.type === "string" ? raw.type : "";
          const aspects = skillAspects(raw);
          const names = [
            typeof raw.name === "string" && raw.name ? raw.name : id,
          ];
          for (const name of seedNames.get(id) ?? []) {
            if (!names.includes(name)) names.push(name);
          }
          list.push({
            id,
            icon: typeof raw.icon === "string" && raw.icon ? raw.icon : id,
            names,
            stats: [...aspects],
            aspects,
            type: raw.type,
            countTarget: raw.countTarget === true,
            countUnit: typeof raw.countUnit === "string" ? raw.countUnit : "",
            cls: job,
            baseRank: list.length,
            gameData: true,
          });
        }
        if (list.length) SKILLS[job] = list;
      }
      // Skills the payload does not list keep their seed entry; replace their
      // aspects with the live module's exact set.
      for (const list of Object.values(SKILLS)) {
        for (const entry of list) {
          const raw = skillData.get(entry.id);
          if (!raw) continue;
          const aspects = skillAspects(raw, entry.aspects);
          if (!aspects.length) continue;
          entry.aspects = aspects;
          entry.stats = [...aspects];
          entry.countTarget = raw.countTarget === true;
          entry.countUnit =
            typeof raw.countUnit === "string" ? raw.countUnit : "";
        }
      }
      // Learned skills (advanced-job cards) also get their exact live aspects.
      for (const list of Object.values(learnedSkills)) {
        for (const entry of list) {
          const meta =
            liveSkillMeta.get(entry.id) ?? liveSkillByIcon.get(entry.icon);
          if (!meta) continue;
          if (meta.type) {
            SKILL_TYPES[entry.id] = meta.type;
            entry.type = meta.type;
          }
          const aspects = skillAspects(meta, entry.aspects);
          if (!aspects.length) continue;
          entry.aspects = aspects;
          entry.stats = [...aspects];
          entry.countTarget = meta.countTarget === true;
          entry.countUnit = meta.countUnit || "";
        }
      }
      if (payload.mainStat && typeof payload.mainStat === "object") {
        for (const [job, stat] of Object.entries(payload.mainStat)) {
          if (
            Object.hasOwn(MAIN_STAT, job) &&
            typeof stat === "string" &&
            Object.hasOwn(STAT_LABELS, stat)
          ) {
            MAIN_STAT[job] = stat;
          }
        }
      }
      const itemData = new Map();
      for (const raw of itemsRaw) {
        if (!raw || typeof raw.id !== "string" || !SAFE_ID.test(raw.id)) continue;
        const stats = cleanStats(
          (Array.isArray(raw.lines) ? raw.lines : []).flatMap((line) => [
            ...lineKeys(line),
          ]),
        );
        itemData.set(raw.id, {
          id: raw.id,
          names: [typeof raw.name === "string" && raw.name ? raw.name : raw.id],
          stats,
          slot: SLOT_TYPES.includes(raw.slot) ? raw.slot : "",
          icon: typeof raw.icon === "string" ? raw.icon : "",
          run: typeof raw.run === "string" && SAFE_ID.test(raw.run) ? raw.run : "",
        });
      }
      if (itemData.size < 5) return null;
      const seenItems = new Set();
      for (const list of Object.values(ITEMS)) {
        for (const entry of list) {
          const raw = itemData.get(entry.id);
          if (!raw) continue;
          seenItems.add(entry.id);
          mergeItemData(entry, raw);
        }
      }
      for (const raw of itemData.values()) {
        if (seenItems.has(raw.id)) continue;
        ITEMS.common.push({
          id: raw.id,
          names: raw.names,
          stats: raw.stats,
          slot: raw.slot,
          icon: raw.icon,
          run: raw.run,
          gameData: true,
        });
        seenItems.add(raw.id);
      }
      rebuildSkillIndex();
      rebuildItemIndex();
      dropItemCaches();
      deityCache.clear();
      const counts =
        payload.counts && typeof payload.counts === "object" ? payload.counts : {};
      return {
        skills: skillData.size,
        items: itemData.size,
        classes: Number(counts.classes) || 0,
        talents: Number(counts.talents) || 0,
      };
    };

    // ------------------------------------------------------ table lookups --
    const classSkills = (job) => [
      ...(SKILLS[job] ?? []),
      ...(learnedSkills[job] ?? []),
      AUTO_SKILL,
    ];
    const baseItems = (job) => [
      ...ITEMS.common,
      ...(job && ITEMS[job] ? ITEMS[job] : []),
    ];
    const classItems = (job) => {
      const key = job || "";
      const cached = classItemsCache.get(key);
      if (cached) return cached;
      const list = baseItems(job);
      const seen = new Set(list.map((entry) => entry.id));
      for (const entry of learnedItems) {
        if (seen.has(entry.id)) continue;
        if (entry.jobs && (!job || !entry.jobs.includes(job))) continue;
        seen.add(entry.id);
        list.push(entry);
      }
      classItemsCache.set(key, list);
      return list;
    };
    const itemTables = (job) => {
      const key = job || "";
      const cached = itemTablesCache.get(key);
      if (cached) return cached;
      const byRun = new Map();
      const byIcon = new Map();
      const byName = new Map();
      for (const entry of classItems(job)) {
        if (entry.run) byRun.set(entry.run, entry);
        if (entry.icon) byIcon.set(String(entry.icon), entry);
        for (const name of entry.names) byName.set(lower(name), entry);
      }
      const tables = { byRun, byIcon, byName };
      itemTablesCache.set(key, tables);
      return tables;
    };

    const availableSkillAspects = (skill) => {
      if (!skill) return ["any"];
      const type = SKILL_TYPES[skill.id];
      const base =
        skill === AUTO_SKILL
          ? AUTO_ASPECTS
          : (skill.aspects ??
            SKILL_ASPECTS[type] ??
            skill.stats ??
            []);
      const keys = ["any", ...base];
      if ((skill.stats ?? []).includes("effect") || base.includes("effect")) {
        keys.push("effect");
      }
      return [...new Set(keys)];
    };
    const availableItemStats = (name) => {
      if (!name) return ["any"];
      const entry = itemById.get(name);
      if (entry?.skillDeity) return ["any"];
      return ["any", ...new Set(ITEM_STATS[name] ?? entry?.stats ?? [])];
    };
    const availableUpgradeSkills = (build) => {
      const ids = new Set([
        ...(build?.required ?? []).filter(Boolean),
        AUTO_SKILL.id,
      ]);
      return [...ids].map((id) => skillById.get(id)).filter(Boolean);
    };

    const skillDeityEntry = (skill) => {
      let entry = deityCache.get(skill.id);
      if (!entry) {
        entry = {
          id: `deity_${skill.id}`,
          names: skill.names.map((name) => `${name} Deity`),
          icon: skill.icon,
          skillId: skill.id,
          skillDeity: true,
          stats: [],
        };
        deityCache.set(skill.id, entry);
      }
      return entry;
    };
    const skillDeityEntries = (job) =>
      classSkills(job)
        .filter((skill) => skill !== AUTO_SKILL)
        .map(skillDeityEntry);
    const isDeityEntry = (entry) =>
      !!entry &&
      (entry.id.startsWith("g_") || !!entry.skillDeity || entry.slot === "deity");

    const itemSlot = (entry) => {
      if (entry && typeof entry === "object" && entry.slot) return entry.slot;
      const id = typeof entry === "string" ? entry : (entry?.id ?? "");
      if (id.startsWith("deity_") || id.startsWith("g_")) return "deity";
      if (id.startsWith("p_")) return "potion";
      if (id.startsWith("e_")) return "elixir";
      if (id.startsWith("b_")) return "blessing";
      if (id.startsWith("d_")) return "dish";
      if (typeof entry === "string") return itemById.get(id)?.slot ?? "";
      return "";
    };

    const styleScore = (entry, focus) => {
      if (!focus) return 0;
      let value = 0;
      for (let i = 0; i < focus.length; i++) {
        if (entry.stats?.includes(focus[i])) value += focus.length - i;
      }
      return value;
    };
    const orderedSkillsForLoadout = (job, loadout) => {
      const list = SKILLS[job] ?? [];
      if (!loadout.skills) return [...list];
      return [...list].sort(
        (a, b) =>
          styleScore(b, loadout.skills) - styleScore(a, loadout.skills) ||
          a.baseRank - b.baseRank,
      );
    };
    const orderedItemsForLoadout = (job, loadout) => {
      const list = baseItems(job);
      if (!loadout.items) return list;
      const rank = new Map(list.map((entry, index) => [entry, index]));
      const focus = [...loadout.items, MAIN_STAT[job]].filter(Boolean);
      return [...list].sort(
        (a, b) =>
          styleScore(b, focus) - styleScore(a, focus) ||
          rank.get(a) - rank.get(b),
      );
    };

    // ------------------------------------------------------------- builds --
    const BUILD_VERSION = 4;
    const AUTO_MODES = ["normal", "focus", "banish", "ignore"];
    const cleanLimit = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, number) : 0;
    };
    const makeRow = (name, upgrade = "any", limit = 0) => ({
      id: newRowId(),
      name,
      upgrade,
      limit: cleanLimit(limit),
    });
    const normalizeRows = (rows, seen) =>
      (Array.isArray(rows) ? rows : [])
        .filter((row) => row && typeof row === "object")
        .map((row) => {
          let id = typeof row.id === "string" && row.id ? row.id : newRowId();
          if (seen.has(id)) id = newRowId();
          seen.add(id);
          return {
            id,
            name: typeof row.name === "string" ? row.name : "",
            upgrade:
              typeof row.upgrade === "string" && row.upgrade
                ? row.upgrade
                : "any",
            limit: cleanLimit(row.limit),
          };
        });
    const uniqueIds = (list) =>
      Array.isArray(list)
        ? [...new Set(list.filter((id) => typeof id === "string" && id))]
        : [];

    const normalizeBuild = (input) => {
      const build = input && typeof input === "object" ? input : {};
      if (typeof build.id !== "string" || !build.id) build.id = "b" + shortId();
      build.name =
        typeof build.name === "string" && build.name.trim()
          ? build.name.trim().slice(0, 60)
          : "Build";

      const required = Array.isArray(build.required)
        ? build.required.slice(0, 4)
        : [];
      while (required.length < 4) required.push("");
      const taken = new Set();
      build.required = required.map((id) => {
        if (typeof id !== "string" || !id) return "";
        if (id === AUTO_SKILL.id || taken.has(id)) return "";
        taken.add(id);
        return id;
      });

      build.newOverUpgrades = build.newOverUpgrades !== false;
      build.manualFallback = !!(build.manualFallback ?? build.skipNoPriority);
      build.fillSlotsFirst = !!build.fillSlotsFirst;
      build.focusSkills = uniqueIds(build.focusSkills);
      build.focusItems = uniqueIds(build.focusItems);
      const hadAutoFocus =
        build.autoMode === undefined &&
        build.focusSkills.includes(AUTO_SKILL.id);
      build.autoMode = AUTO_MODES.includes(build.autoMode)
        ? build.autoMode
        : hadAutoFocus
          ? "focus"
          : "normal";
      build.focusSkills = build.focusSkills.filter(
        (id) => id !== AUTO_SKILL.id,
      );
      build.rerollNoSkill = !!(build.rerollNoSkill ?? build.rerollNoMatch);
      build.rerollNoUpgrade = !!build.rerollNoUpgrade;
      build.itemRerollNoPriority = !!(
        build.itemRerollNoPriority ?? build.rerollNoMatch
      );
      build.itemRerollDeityWrong = !!(
        build.itemRerollDeityWrong ?? build.rerollDeity
      );
      build.mandatoryCardReroll = !!build.mandatoryCardReroll;
      build.mandatoryFullReroll = !!build.mandatoryFullReroll;
      const maxRerolls = Number(build.maxRerolls);
      build.maxRerolls =
        build.maxRerolls != null && Number.isFinite(maxRerolls)
          ? clamp(Math.round(maxRerolls), 0, 10)
          : 3;

      const seenRows = new Set();
      const upgradeable = new Set([
        ...build.required.filter(Boolean),
        AUTO_SKILL.id,
      ]);
      build.skillUpgrades = normalizeRows(build.skillUpgrades, seenRows)
        .filter((row) => upgradeable.has(row.name))
        .map((row) => {
          const skill = skillById.get(row.name);
          // A skill this version does not know keeps its row untouched.
          if (!skill) return row;
          const aspects = availableSkillAspects(skill);
          if (aspects.includes(row.upgrade)) return row;
          // Older builds stored target-count upgrades as "count". Preserve
          // them when the live skill now exposes them as "targets".
          const alias =
            row.upgrade === "count" && aspects.includes("targets")
              ? "targets"
              : row.upgrade === "targets" && aspects.includes("count")
                ? "count"
                : "";
          return { ...row, upgrade: alias || "any" };
        });

      let groups = Array.isArray(build.itemGroups) ? build.itemGroups : null;
      if (!groups) {
        groups = [
          {
            id: newRowId(),
            name: "Priority",
            mandatory: false,
            rows: Array.isArray(build.itemUpgrades) ? build.itemUpgrades : [],
          },
        ];
      }
      const seenGroups = new Set();
      build.itemGroups = groups
        .filter((group) => group && typeof group === "object")
        .map((group, index) => {
          let id =
            typeof group.id === "string" && group.id ? group.id : newRowId();
          if (seenGroups.has(id)) id = newRowId();
          seenGroups.add(id);
          return {
            id,
            name:
              typeof group.name === "string"
                ? group.name.slice(0, 60)
                : `Group ${index + 1}`,
            mandatory: index === 0 ? !!group.mandatory : false,
            rows: normalizeRows(group.rows, seenRows)
              .filter((row) => row.name)
              .map((row) =>
                availableItemStats(row.name).includes(row.upgrade)
                  ? row
                  : { ...row, upgrade: "any" },
              ),
          };
        });
      if (!build.itemGroups.length) {
        build.itemGroups = [
          { id: newRowId(), name: "Group 1", mandatory: false, rows: [] },
        ];
      }
      delete build.itemUpgrades;
      delete build.rerollNoMatch;
      delete build.rerollPriority;
      delete build.rerollDeity;
      delete build.skipNoPriority;
      return build;
    };

    const defaultUpgradeAspects = (entry, max) => {
      const available = availableSkillAspects(entry).filter(
        (key) => key !== "any",
      );
      const ordered = (entry.stats ?? []).filter((key) =>
        available.includes(key),
      );
      return (ordered.length ? ordered : available).slice(0, max);
    };
    const legacyCustom = () => {
      const data = ls.json(KEYS.legacy, null);
      return data && typeof data === "object" ? data : {};
    };

    const makeDefaultBuild = (job, loadout) => {
      const legacy = legacyCustom()[loadout.id]?.[job];
      let required = orderedSkillsForLoadout(job, loadout)
        .slice(0, 4)
        .map((entry) => entry.id);
      if (Array.isArray(legacy?.skills) && legacy.skills.length) {
        const valid = legacy.skills.filter(
          (id) => skillById.get(id)?.cls === job,
        );
        if (valid.length) required = valid.slice(0, 4);
      }
      while (required.length < 4) required.push("");
      const skillUpgrades = [];
      for (const id of required) {
        const entry = id ? skillById.get(id) : null;
        if (!entry) continue;
        for (const stat of defaultUpgradeAspects(entry, 3)) {
          skillUpgrades.push(makeRow(id, stat));
        }
      }
      for (const stat of defaultUpgradeAspects(AUTO_SKILL, 6)) {
        skillUpgrades.push(makeRow(AUTO_SKILL.id, stat));
      }
      let items = orderedItemsForLoadout(job, loadout)
        .slice(0, 12)
        .map((entry) => entry.id);
      if (Array.isArray(legacy?.items) && legacy.items.length) {
        const valid = legacy.items.filter((id) => itemById.has(id));
        if (valid.length) items = valid;
      } else {
        items = [
          ...items,
          ...(ITEMS[job] ?? [])
            .map((entry) => entry.id)
            .filter((id) => !items.includes(id)),
        ];
      }
      return normalizeBuild({
        id: "b" + loadout.id + shortId().slice(0, 5),
        name: loadout.name,
        required,
        autoMode: "normal",
        newOverUpgrades: true,
        manualFallback: false,
        fillSlotsFirst: false,
        rerollNoSkill: false,
        rerollNoUpgrade: false,
        itemRerollNoPriority: false,
        itemRerollDeityWrong: false,
        mandatoryCardReroll: false,
        mandatoryFullReroll: false,
        maxRerolls: 3,
        focusSkills: [],
        focusItems: [],
        skillUpgrades,
        itemGroups: [
          {
            id: newRowId(),
            name: "Priority",
            mandatory: false,
            rows: items.map((id) => makeRow(id, "any")),
          },
        ],
      });
    };

    const cloneBuild = (base, name) =>
      normalizeBuild({
        ...JSON.parse(JSON.stringify(base)),
        id: "b" + shortId(),
        name,
        skillUpgrades: (base.skillUpgrades ?? []).map((row) => ({
          ...row,
          id: newRowId(),
        })),
        itemGroups: (base.itemGroups ?? []).map((group) => ({
          id: newRowId(),
          name: group.name,
          mandatory: !!group.mandatory,
          rows: (group.rows ?? []).map((row) => ({ ...row, id: newRowId() })),
        })),
      });

    const defaultBucket = (job) => {
      const builds = LOADOUTS.map((loadout) => makeDefaultBuild(job, loadout));
      return { builds, active: builds[0]?.id ?? null };
    };
    const normalizeBucket = (job, bucket) => {
      if (!bucket || typeof bucket !== "object" || !Array.isArray(bucket.builds)) {
        return defaultBucket(job);
      }
      const seen = new Set();
      const builds = [];
      for (const raw of bucket.builds) {
        if (!raw || typeof raw !== "object") continue;
        let build = null;
        try {
          build = normalizeBuild(raw);
        } catch (error) {
          noteError("build", error);
          continue;
        }
        if (seen.has(build.id)) build.id = "b" + shortId();
        seen.add(build.id);
        builds.push(build);
      }
      const active = builds.some((build) => build.id === bucket.active)
        ? bucket.active
        : (builds[0]?.id ?? null);
      return { builds, active };
    };

    let buildData = { version: BUILD_VERSION, classes: {} };
    const saveBuildData = () =>
      queueSave(KEYS.builds, () => JSON.stringify(buildData));
    const loadBuildData = () => {
      const raw = ls.get(KEYS.builds);
      let data = null;
      if (raw != null) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
        const usable =
          !!data &&
          typeof data === "object" &&
          !!data.classes &&
          typeof data.classes === "object";
        if (!usable) {
          // Unreadable data is set aside instead of being overwritten.
          ls.set(KEYS.builds + ".unreadable", raw);
          data = null;
        }
      }
      const out = { version: BUILD_VERSION, classes: {} };
      if (data) {
        for (const [job, bucket] of Object.entries(data.classes)) {
          if (!SKILLS[job]) out.classes[job] = bucket;
        }
      }
      for (const job of Object.keys(SKILLS)) {
        const bucket = data?.classes?.[job];
        out.classes[job] = bucket
          ? normalizeBucket(job, bucket)
          : defaultBucket(job);
      }
      if (data && (Number(data.version) || 1) < 3) {
        for (const job of Object.keys(SKILLS)) {
          for (const build of out.classes[job].builds) {
            if (build.skillUpgrades.some((row) => row.name === AUTO_SKILL.id)) {
              continue;
            }
            for (const stat of AUTO_SKILL.stats.slice(0, 6)) {
              build.skillUpgrades.push(makeRow(AUTO_SKILL.id, stat));
            }
          }
        }
      }
      return out;
    };

    let cls = null;
    let activeBuild = null;
    let activeBuildClass = null;
    // Name of the build picked by hand in this run's start prompt.
    let promptChoiceName = null;
    let settingsClass = "swordsman";

    const classBuilds = (job) => {
      const bucket = buildData.classes[job];
      if (bucket && Array.isArray(bucket.builds)) return bucket;
      buildData.classes[job] = { builds: [], active: null };
      return buildData.classes[job];
    };
    const resolveActiveBuild = (job) => {
      const bucket = classBuilds(job);
      activeBuild =
        bucket.builds.find((build) => build.id === bucket.active) ??
        bucket.builds[0] ??
        null;
      activeBuildClass = job;
    };
    const setActiveBuild = (job, build) => {
      const bucket = classBuilds(job);
      bucket.active = build?.id ?? null;
      if (!activeBuildClass || activeBuildClass === job) {
        activeBuild = build ?? null;
        activeBuildClass = job;
      }
      saveBuildData();
    };
    const switchActiveBuildForClass = (job) => {
      if (!job || activeBuildClass === job) return;
      const bucket = classBuilds(job);
      const chosen = promptChoiceName
        ? bucket.builds.find((build) => build.name === promptChoiceName)
        : null;
      activeBuild =
        chosen ??
        bucket.builds.find((build) => build.id === bucket.active) ??
        bucket.builds[0] ??
        null;
      activeBuildClass = job;
      if (activeBuild && bucket.active !== activeBuild.id) {
        bucket.active = activeBuild.id;
        saveBuildData();
      }
    };
    const buildUses = (build, id) =>
      !!build &&
      (build.required.includes(id) ||
        build.skillUpgrades.some((row) => row.name === id) ||
        build.itemGroups.some((group) =>
          group.rows.some((row) => row.name === id),
        ) ||
        build.focusItems.includes(id) ||
        build.focusSkills.includes(id));

    // --------------------------------------------------------- loot rules --
    const ACTION_VALUES = ["need", "greed", "pass"];
    const normalizePickupData = (data) => {
      const rules = Array.isArray(data?.rules) ? data.rules : [];
      return {
        rules: rules
          .map((rule) => ({
            name: typeof rule?.name === "string" ? rule.name.slice(0, 80) : "",
            quality: Number.isInteger(rule?.quality)
              ? clamp(rule.quality, -1, 4)
              : -1,
            action: ACTION_VALUES.includes(rule?.action) ? rule.action : "pass",
          }))
          .filter((rule) => rule.name),
        other: ACTION_VALUES.includes(data?.other) ? data.other : "pass",
      };
    };
    let pickupData = { rules: [], other: "pass" };
    const loadPickupData = () => normalizePickupData(ls.json(KEYS.pickup, {}));
    const savePickupData = () =>
      queueSave(KEYS.pickup, () => JSON.stringify(pickupData));

    // =====================================================================
    // 3. Cards
    // =====================================================================

    // ------------------------------------------------------------ rarity --
    const parseColor = (value) => {
      const raw = lower(value).trim();
      let match = raw.match(/^#([0-9a-f]{3})$/);
      if (match) return match[1].split("").map((ch) => parseInt(ch + ch, 16));
      match = raw.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
      if (match) {
        return [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16));
      }
      match = raw.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
      if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
      return null;
    };
    const RARITY_RGB = [...RARITY].map(([hex, rank]) => ({
      rank,
      rgb: parseColor(hex),
    }));
    // Dropped items and cards are diamonds painted in these colours. Common
    // (white) is skipped: the map itself is full of white-ish pixels.
    const ITEM_QUALITY_RGB = RARITY_RGB.filter((entry) => entry.rank > 0);
    const nearRgb = (r, g, b, rgb) =>
      Math.abs(r - rgb[0]) <= 18 &&
      Math.abs(g - rgb[1]) <= 18 &&
      Math.abs(b - rgb[2]) <= 18;
    const rarityFromColor = (value) => {
      const raw = lower(value).trim();
      if (!raw) return 0;
      if (RARITY.has(raw)) return RARITY.get(raw);
      const rgb = parseColor(raw);
      if (!rgb) return 0;
      let best = 0;
      let bestDistance = Infinity;
      for (const entry of RARITY_RGB) {
        if (!entry.rgb) continue;
        const distance = Math.hypot(
          rgb[0] - entry.rgb[0],
          rgb[1] - entry.rgb[1],
          rgb[2] - entry.rgb[2],
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          best = entry.rank;
        }
      }
      return bestDistance <= 40 ? best : 0;
    };
    // The game paints rarity through a --q colour on the element.
    const rarityOf = (el, inner) => {
      let value = el?.style?.getPropertyValue("--q") || "";
      if (!value.trim() && inner && inner !== el) {
        value = inner.style?.getPropertyValue("--q") || "";
      }
      if (!value.trim() && el) {
        try {
          value = getComputedStyle(el).getPropertyValue("--q") || "";
        } catch {
          value = "";
        }
      }
      return rarityFromColor(value);
    };

    // ------------------------------------------------- upgrade line text --
    // Phrases that contain another stat's word. They are matched first and
    // removed, so "Critical Damage" is not also counted as crit and damage.
    const COMPOUND_PATTERNS = [
      ["critDmg", /critical damage|crit(?:ical)? dmg|daño cr[ií]tico|爆擊傷害|爆击伤害|暴擊傷害|暴击伤害/gi],
      ["damageReduction", /damage taken|damage reduction|daño recibido|reducci[oó]n de daño|受到的伤害|受到的傷害|傷害減免|伤害减免/gi],
      ["dot", /damage over time|daño en el tiempo|持續傷害|持续伤害/gi],
      ["double", /double cast|doble casteo|雙重詠唱|双重咏唱/gi],
      ["cast", /cast(?:ing)? speed|cast time|rapidez de casteo|velocidad de casteo|tiempo de casteo/gi],
      ["speed", /projectile speed|velocidad de(?:l| los)? proyectil(?:es)?|投射物?速度|彈道速度|弹道速度/gi],
    ];
    const STAT_PATTERNS = [
      ["cast", /詠唱|吟唱|咏唱/i],
      ["crit", /critical|cr[ií]tico|\bcrit\b|爆擊|爆击|暴擊|暴击/i],
      ["reach", /\breach\b|alcance|distancia|距離|距离/i],
      ["area", /\barea\b|área|範圍|范围/i],
      ["duration", /duration|duración|持續|持续/i],
      ["pierce", /pierce|perforación|穿透/i],
      ["speed", /\bspeed\b|velocidad|速度/i],
      ["targets", /targets?|objetivos?|目標|目标/i],
      ["count", /proyectil|projectile|bolt|arrow|knife|shuriken|spear|meteor|bola|flecha|cuchillo|bala|bullet|impact|pulso|pulse|celda|cell|orbe|orb|andanada|volley|ráfaga|rafaga|burst|carga|charge|abrojo|caltrop|llama|flame|alma|soul|pétalo|petal|kunai|發射|投射|脈衝|脉冲|衝擊|冲击|齊射|齐射|充能|寶珠|宝珠/i],
      ["hp", /max hp|vida máxima|最大.*hp|hp máximo|最大生命|生命上限/i],
      ["armor", /armor|armadura|護甲|护甲/i],
      ["regen", /regenerat|regen|regeneración|回復|回复|恢復|恢复|\bevery\s+\d+\s*s\b|cada\s+\d+\s*s\b|每秒/i],
      ["lifesteal", /lifesteal|life steal|robo de vida|吸血/i],
      ["flee", /flee|esquiva|閃避|闪避/i],
      ["dot", /poison|veneno|burn|quemadura|bleed|sangrado/i],
      ["zeny", /zeny/i],
      ["exp", /\bexp\b|experiencia|經驗|经验/i],
      ["pickup", /pickup|recogida|拾取/i],
      ["discovery", /discovery|descubrimiento|發現|发现/i],
      ["str", /\bstr\b/i],
      ["agi", /\bagi\b/i],
      ["vit", /\bvit\b/i],
      ["int", /\bint\b/i],
      ["dex", /\bdex\b/i],
      ["luk", /\bluk\b/i],
      ["cd", /haste|celeridad|cooldown|enfriamiento|冷卻|冷却/i],
      ["dmg", /damage|daño|\bdmg\b|伤害|傷害/i],
    ];
    // Effect cards put the label first ("Slow: +1.7 s"), so these are only
    // used for lines that do not start with a number. They stay label-specific
    // so unique-effect text containing "damage" is not treated as a damage
    // upgrade.
    const EFFECT_PATTERNS = [
      ["stun", /stun|aturd|眩暈|眩晕/i],
      ["mark", /extra damage taken|daño extra que reciben|額外受到|额外受到/i],
      ["weaken", /damage lost|daño que pierden|失去.*伤害|失去.*傷害/i],
      ["damageReduction", /buff damage reduction|damage reduction|reducci[oó]n de daño|減傷|减伤/i],
      ["heal", /hp regenerad|healing|heal|curaci[oó]n|治療|治疗|回復|回复/i],
      ["slow", /slow|ralentiz|減速|减速/i],
      ["freeze", /freeze|congel|凍結|冻结/i],
      ["agiDex", /buff agi and dex|agi y dex|agi.*dex/i],
      ["holy", /extra holy damage taken|daño sagrado extra|神聖|神圣/i],
      ["fervor", /blessed basic attacks|ataques básicos bendecidos|狂熱|狂热/i],
      ["dot", /poison damage|daño del veneno|中毒/i],
      ["blind", /blind|ceg|致盲|黑暗/i],
      ["flee", /buff flee|flee del buff|閃避|闪避/i],
      ["speed", /buff movement speed|velocidad del buff|移動速度|移动速度/i],
      ["dmg", /^buff damage(?! reduction)|^damage on exit|^daño del buff|^daño al salir/i],
      ["cast", /buff cast speed|rapidez de casteo del buff|詠唱速度|吟唱速度/i],
      ["cd", /haste|celeridad|冷卻|冷却/i],
      ["duration", /duration|duraci[oó]n|持續|持续/i],
      ["block", /block chance|probabilidad de bloquear|格擋|格挡/i],
      ["sleep", /sleep|sueño|睡眠/i],
    ];
    const lineKeys = (line) => {
      let rest = String(line ?? "").trim();
      const keys = new Set();
      // A line that does not start with a number describes a unique effect.
      if (!/^[+\-−\d]/.test(rest)) {
        keys.add("effect");
        for (const [key, pattern] of EFFECT_PATTERNS) {
          if (pattern.test(rest)) keys.add(key);
        }
        return keys;
      }
      for (const [key, pattern] of COMPOUND_PATTERNS) {
        pattern.lastIndex = 0;
        if (!pattern.test(rest)) continue;
        keys.add(key);
        pattern.lastIndex = 0;
        rest = rest.replace(pattern, " ");
      }
      for (const [key, pattern] of STAT_PATTERNS) {
        if (pattern.test(rest)) keys.add(key);
      }
      return keys;
    };
    // First number on the line; "1,5" is a decimal, "1,500" is a thousand.
    const lineValue = (line) => {
      const match = String(line ?? "").match(/\d+(?:[.,]\d+)?/);
      if (!match) return 1;
      const raw = match[0];
      const value = /^\d{1,3}[.,]\d{3}$/.test(raw)
        ? Number(raw.replace(/[.,]/, ""))
        : Number(raw.replace(",", "."));
      return Number.isFinite(value) ? value : 1;
    };
    const cardValueFor = (c, upgrade) => {
      let add = 0;
      c.lines.forEach((line, index) => {
        if (upgrade === "any" || c.lineSets[index].has(upgrade)) {
          add += lineValue(line);
        }
      });
      return Math.max(1, add);
    };

    // ------------------------------------------------------ reading cards --
    const IMAGE_EXT = "(?:png|webp|gif|jpe?g|avif)";
    const ICON_SRC = new RegExp(`/icons/([a-z0-9_]+)\\.${IMAGE_EXT}`, "i");
    const RUN_SRC = new RegExp(`/runitems/([a-z0-9_]+)\\.${IMAGE_EXT}`, "i");
    const ITEM_SRC = new RegExp(`/items/(\\d+)\\.${IMAGE_EXT}`, "i");
    const identityOf = (scope) => {
      const src = scope.querySelector(".pk-art img")?.getAttribute("src") || "";
      let match = src.match(ICON_SRC);
      if (match) return { icon: match[1].toLowerCase() };
      match = src.match(RUN_SRC);
      if (match) return { run: match[1].toLowerCase() };
      match = src.match(ITEM_SRC);
      if (match) return { icon: match[1] };
      return {};
    };

    const MEAT_NAME = /^(carne|meat|肉)$/i;
    const LEVEL_TEXT = /(?:\b(?:lv|nv|nivel|level)\.?|等[级級])\s*(\d+)/i;
    const readCard = (card) => {
      const slot = card.closest(".pk-slot") || card;
      const name = text(slot, ".pk-name");
      const sub = text(slot, ".pk-sub");
      const lines = $$(".pk-lines li", slot).map((line) =>
        (line.textContent || "").trim(),
      );
      const lineSets = lines.map(lineKeys);
      const keys = new Set();
      for (const set of lineSets) for (const key of set) keys.add(key);
      const level = sub.match(LEVEL_TEXT);
      const pid = identityOf(slot);
      return {
        card,
        slot,
        name,
        sub,
        lines,
        lineSets,
        keys,
        pid,
        quality: rarityOf(slot, card),
        fresh: !!slot.querySelector(".pk-ribbon"),
        swap: !!slot.querySelector(".pk-swap"),
        level: level ? Math.min(25, Number(level[1])) : 0,
        meat: MEAT_NAME.test(name),
        chosen:
          slot.classList.contains("chosen") ||
          card.classList.contains("chosen"),
        sig: [pid.icon || pid.run || "", name, sub, lines.join("¦")].join("§"),
        hit: null,
        detected: null,
        score: 0,
      };
    };
    const cardLabel = (c) => {
      const name = c.name || c.hit?.entry?.names?.[0] || "card";
      const first = c.lines.find((line) => line);
      return first ? `${name} (${first})` : name;
    };

    // ------------------------------------------------------ identification --
    const DEITY_WORD = /deity|deidad|神祇|神祗/i;
    const isDeityCard = (name, sub) =>
      DEITY_WORD.test(name) || DEITY_WORD.test(sub) || /之神\s*$/.test(name);
    const AUTO_NAME = /^(?:attack|ataque|攻击|攻擊)\s*[:：]/i;

    const identifyCard = (c, job) => {
      const { pid, name, sub } = c;
      const tables = itemTables(job);
      if (isDeityCard(name, sub)) {
        let item = pid.icon ? tables.byIcon.get(pid.icon) : null;
        if (!item) item = tables.byName.get(lower(name));
        if (item && (item.id.startsWith("g_") || item.skillDeity)) {
          return { kind: "item", entry: item };
        }
        let deitySkill = pid.icon ? skillByIcon.get(pid.icon) : null;
        if (!deitySkill) {
          const base = name
            .replace(/\s+(?:deity|deidad|神祇|神祗).*$/i, "")
            .replace(/^(?:deity|deidad)\s+(?:of|del?)\s+(?:(?:the|la|el|los|las)\s+)?/i, "")
            .replace(/之神\s*$/, "")
            .trim();
          deitySkill = skillByName.get(lower(base)) ?? null;
        }
        if (deitySkill && deitySkill !== AUTO_SKILL) {
          return { kind: "item", entry: skillDeityEntry(deitySkill) };
        }
      } else {
        let skill = pid.icon ? skillByIcon.get(pid.icon) : null;
        if (!skill) skill = skillByName.get(lower(name));
        if (!skill && AUTO_NAME.test(name)) skill = AUTO_SKILL;
        if (skill) return { kind: "skill", entry: skill };
      }
      let item = pid.run ? tables.byRun.get(pid.run) : null;
      if (!item && pid.icon) item = tables.byIcon.get(pid.icon);
      if (!item) item = tables.byName.get(lower(name));
      return item ? { kind: "item", entry: item } : null;
    };

    // ---------------------------------------------------- class detection --
    const classFromHud = () => {
      const hud = lower($("#hud")?.textContent || "");
      if (!hud) return null;
      for (const [job, pattern] of CLASS_HUD) {
        if (pattern.test(hud)) return job;
      }
      return null;
    };
    const syncClass = () => {
      if (!cls) cls = classFromHud();
      if (cls) switchActiveBuildForClass(cls);
    };
    // The skills on offer and the skills already learned say which class is
    // being played far more reliably than any text on screen. A single odd
    // card cannot outvote the skills the hero already has.
    const voteClass = (cards, learnedIds) => {
      const votes = new Map();
      const add = (job, weight) => {
        if (job && SKILLS[job]) votes.set(job, (votes.get(job) ?? 0) + weight);
      };
      for (const id of learnedIds) {
        const entry = skillById.get(id);
        if (entry && entry !== AUTO_SKILL && !entry.learned) add(entry.cls, 2);
      }
      for (const c of cards) {
        let entry = c.pid.icon ? skillByIcon.get(c.pid.icon) : null;
        if (!entry && !isDeityCard(c.name, c.sub)) {
          entry = skillByName.get(lower(c.name)) ?? null;
        }
        if (entry && entry !== AUTO_SKILL && !entry.learned) {
          add(entry.cls, 1);
        } else if (!entry && c.pid.icon) {
          const prefix = c.pid.icon.split("_")[0];
          if (Object.hasOwn(CLASS_ICON, prefix)) add(CLASS_ICON[prefix], 0.5);
        }
      }
      let best = null;
      let bestVotes = 0;
      for (const [job, count] of votes) {
        if (count > bestVotes || (count === bestVotes && job === cls)) {
          best = job;
          bestVotes = count;
        }
      }
      return best;
    };

    // ------------------------------------------------------------ sockets --
    const SKILL_WORDS = /skills|habilidades|技能/i;
    const ITEM_WORDS = /items|objetos|物品|道具/i;
    const readSockets = () => {
      const socket = $("#lu-sockets");
      const socketText = text(socket, "span");
      const slots = socketText.match(/(\d+)\s*\/\s*(\d+)/);
      const learnedIds = new Set();
      const itemValues = new Set();
      if (socket) {
        for (const el of socket.querySelectorAll("[data-skill]")) {
          const id = el.dataset.skill;
          if (!id) continue;
          if (id.startsWith("atk_")) {
            learnedIds.add(AUTO_SKILL.id);
            continue;
          }
          learnedIds.add(id);
          // Detected skills are stored under their icon name, so match the
          // socket picture as well as the game's own id.
          const src =
            (el.tagName === "IMG" ? el : el.querySelector("img"))?.getAttribute(
              "src",
            ) || "";
          const icon = src.match(ICON_SRC);
          const known = icon ? skillByIcon.get(icon[1].toLowerCase()) : null;
          if (known) learnedIds.add(known.id);
        }
        for (const el of socket.querySelectorAll(
          ".sockets .run-slot[data-item]",
        )) {
          itemValues.add(el.dataset.item);
        }
      }
      return {
        visible: !!socket && !socket.classList.contains("hidden"),
        skillsHeader: SKILL_WORDS.test(socketText),
        itemsHeader: ITEM_WORDS.test(socketText),
        slots: slots ? [Number(slots[1]), Number(slots[2])] : null,
        learnedIds,
        itemValues,
      };
    };

    // -------------------------------------------------- learning new cards --
    const learnFromOffer = (cards, sockets) => {
      const before = learnedRevision;
      let widened = false;
      for (const c of cards) {
        if (c.detected || c.meat || !c.name) continue;
        const { run, icon } = c.pid;
        const stats = [...c.keys];
        if (run) {
          registerLearnedItem({ id: run, run, name: c.name, stats });
        } else if (icon && /^\d+$/.test(icon)) {
          if (!sockets.itemsHeader) continue;
          // An item this class is not listed for, or a brand new one.
          const known = [...itemById.values()].find(
            (entry) => String(entry.icon ?? "") === icon,
          );
          const deity = isDeityCard(c.name, c.sub);
          const dish = /dish|plato|料理/i.test(`${c.name} ${c.sub}`);
          registerLearnedItem({
            id: known ? known.id : `x_${icon}`,
            icon,
            name: c.name,
            stats,
            slot: deity ? "deity" : dish ? "dish" : undefined,
            jobs: cls ? [cls] : [],
          });
        } else if (icon && cls && sockets.skillsHeader) {
          if (isDeityCard(c.name, c.sub)) continue;
          registerLearnedSkill(cls, { id: icon, icon, name: c.name, stats });
        }
      }
      // Keep widening the upgrade list of detected skills as cards appear.
      for (const c of cards) {
        const entry = c.detected?.entry;
        if (!entry?.learned || c.detected.kind !== "skill") continue;
        for (const key of c.keys) {
          if (key === "any" || !Object.hasOwn(STAT_LABELS, key)) continue;
          if (entry.stats.includes(key)) continue;
          entry.stats.push(key);
          widened = true;
        }
      }
      const changed = learnedRevision !== before;
      if (changed || widened) saveLearned();
      return changed;
    };

    // ------------------------------------------------------------- offers --
    const readOffer = (picker, cardEls) => {
      skillSummaryCache.clear();
      const cards = cardEls.map(readCard);
      const sockets = readSockets();
      syncClass();
      const voted = voteClass(cards, sockets.learnedIds);
      if (voted && voted !== cls) {
        cls = voted;
        switchActiveBuildForClass(cls);
      }
      const identifyAll = () => {
        for (const c of cards) {
          const raw = identifyCard(c, cls);
          c.detected = raw;
          c.hit =
            raw && raw.entry.learned && !buildUses(activeBuild, raw.entry.id)
              ? null
              : raw;
        }
      };
      identifyAll();
      if (learnFromOffer(cards, sockets)) identifyAll();
      return {
        picker,
        cards,
        sockets,
        sig: cards.map((c) => c.sig).join("‖"),
        anyChosen: cards.some((c) => c.chosen),
      };
    };

    // =====================================================================
    // 4. Decisions
    // =====================================================================
    // Upgrade value taken so far this run, per priority row (for limits).
    const runPickValues = new Map();
    // Skills picked as a "new" card this run, in case the game does not
    // list learned skills where we expect them.
    const runLearned = new Set();

    // The game tooltip has two parts: .st-rows (summary totals) and
    // .st-hist (upgrade history). Limits use the summary, because tower
    // upgrades are folded into the skill totals but not into the history.
    const SUMMARY_PATTERNS = [
      ["dmg", /total damage|daño total|總傷害|总伤害/i],
      ["cd", /cooldown|enfriamiento|冷卻|冷却/i],
      ["cast", /^(?:cast|casteo)$|詠唱|吟唱|咏唱/i],
      ["count", /^(?:count|cantidad)$|數量|数量/i],
      ["targets", /^(?:targets?|objetivos?)$|目標|目标/i],
      ["area", /^(?:area|área)$|範圍|范围/i],
      ["reach", /reach|alcance|距離|距离/i],
      ["pierce", /pierce|perforación|穿透/i],
      ["speed", /projectile speed|orbit speed|movement speed|velocidad de proyectil|velocidad de giro|velocidad de movimiento|投射物?速度|彈道速度|弹道速度|移動速度|移动速度/i],
      ["duration", /duration|duración|持續|持续/i],
      ["crit", /critical|crítico|爆擊|爆击|暴擊|暴击/i],
      ["double", /double cast|doble casteo|雙重詠唱|双重咏唱/i],
    ];
    const summaryKey = (label) => {
      for (const [key, pattern] of SUMMARY_PATTERNS) {
        if (pattern.test(label)) return key;
      }
      for (const [key, pattern] of EFFECT_PATTERNS) {
        if (pattern.test(label)) return key;
      }
      return "";
    };
    const summaryNumber = (raw) => {
      const match = String(raw ?? "").match(/([+\-−]?\d+(?:[.,]\d+)?)/);
      if (!match) return null;
      const value = Number(match[1].replace(/[−–—]/g, "-").replace(",", "."));
      return Number.isFinite(value) ? value : null;
    };
    const summaryValue = (raw, key) => {
      const value = String(raw ?? "").trim();
      if (key === "cast") return null;
      if (key === "cd") {
        const pct = value.match(/\(\s*([+\-−]?\d+(?:[.,]\d+)?)\s*%\s*\)/);
        if (!pct) return 0;
        const number = summaryNumber(pct[1]);
        return number == null ? null : Math.abs(number);
      }
      const pct = value.match(/([+\-−]?\d+(?:[.,]\d+)?)\s*%/);
      if (pct) return summaryNumber(pct[1]);
      return summaryNumber(value);
    };
    const summarySlot = (skillId) => {
      const entry = skillById.get(skillId);
      const meta = liveSkillByIcon.get(entry?.icon);
      const ids = [
        ...new Set(
          [skillId, entry?.id, meta?.id].filter(
            (id) => typeof id === "string" && SAFE_ID.test(id),
          ),
        ),
      ];
      for (const root of [$("#lu-sockets"), $("#skillbar")]) {
        if (!root) continue;
        if (skillId === AUTO_SKILL.id) {
          const slot = root.querySelector('[data-skill^="atk_"]');
          if (slot) return slot;
          continue;
        }
        for (const id of ids) {
          const slot = root.querySelector(`[data-skill="${id}"]`);
          if (slot) return slot;
        }
      }
      return null;
    };
    const readSkillSummary = (skillId) => {
      const slot = summarySlot(skillId);
      const tip = document.getElementById("skill-tip");
      if (!slot || !tip) return null;
      try {
        tip.innerHTML = "";
        slot.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        const rows = tip.querySelector(".st-rows");
        if (!rows) return null;
        const values = new Map();
        for (const labelEl of rows.children) {
          if (labelEl.tagName !== "SPAN") continue;
          const label = (labelEl.textContent || "").trim();
          const raw = (labelEl.nextElementSibling?.textContent || "").trim();
          const key = summaryKey(label);
          if (!key) continue;
          const value = summaryValue(raw, key);
          if (value == null) continue;
          values.set(key, value);
          if (key === "count" && /objetivo|target|目標|目标/i.test(raw)) {
            values.set("countTargets", value);
          }
        }
        return values.size ? values : null;
      } finally {
        tip.classList.add("hidden");
      }
    };
    const skillSummary = (skillId) => {
      if (skillSummaryCache.has(skillId)) return skillSummaryCache.get(skillId);
      const summary = readSkillSummary(skillId);
      skillSummaryCache.set(skillId, summary);
      return summary;
    };
    const summaryUsed = (row) => {
      if (!row || !skillById.has(row.name)) return null;
      if (row.upgrade === "any" || row.upgrade === "effect") return null;
      const summary = skillSummary(row.name);
      if (!summary) return null;
      if (row.upgrade === "targets") {
        const entry = skillById.get(row.name);
        if (entry?.countTarget && summary.has("countTargets")) {
          return summary.get("countTargets");
        }
        if (summary.has("targets")) {
          return Math.max(0, summary.get("targets") - 1);
        }
        return null;
      }
      return summary.has(row.upgrade) ? summary.get(row.upgrade) : null;
    };

    const rowExhausted = (row) =>
      row.limit > 0 && (runPickValues.get(row.id) ?? 0) >= row.limit;
    const rowBlocked = (row, c) => {
      if (row.limit <= 0) return false;
      const used = summaryUsed(row) ?? (runPickValues.get(row.id) ?? 0);
      return used >= row.limit || used + cardValueFor(c, row.upgrade) > row.limit;
    };
    const rowMatches = (row, id, c) =>
      row.name === id && (row.upgrade === "any" || c.keys.has(row.upgrade));
    const hasMatchingRow = (rows, id, c) =>
      rows.some((row) => rowMatches(row, id, c));
    const bestUpgradeRow = (rows, id, c) => {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (rowMatches(row, id, c) && !rowBlocked(row, c)) {
          return { row, index };
        }
      }
      return null;
    };
    const bestItemRow = (c) => {
      if (!activeBuild || c.hit?.kind !== "item") return null;
      const groups = activeBuild.itemGroups ?? [];
      for (let g = 0; g < groups.length; g++) {
        const rows = groups[g].rows ?? [];
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r];
          if (!rowMatches(row, c.hit.entry.id, c) || rowBlocked(row, c)) continue;
          return { row, group: groups[g], groupIndex: g, rowIndex: r };
        }
      }
      return null;
    };
    const matchingItemRows = (c) => {
      const matches = [];
      if (!activeBuild || c.hit?.kind !== "item") return matches;
      (activeBuild.itemGroups ?? []).forEach((group, g) => {
        (group.rows ?? []).forEach((row, r) => {
          if (!rowMatches(row, c.hit.entry.id, c)) return;
          matches.push({ row, group, groupIndex: g, rowIndex: r });
        });
      });
      return matches;
    };

    // Count a taken card against the limits of the rows it satisfies.
    const recordPick = (c) => {
      skillSummaryCache.clear();
      const hit = c.hit;
      if (!hit || !activeBuild) return;
      const valueFor = (upgrade) => cardValueFor(c, upgrade);
      const bump = (row) =>
        runPickValues.set(
          row.id,
          (runPickValues.get(row.id) ?? 0) + valueFor(row.upgrade),
        );
      if (hit.kind === "skill") {
        for (const row of activeBuild.skillUpgrades ?? []) {
          if (rowMatches(row, hit.entry.id, c)) bump(row);
        }
        return;
      }
      for (const { row } of matchingItemRows(c)) {
        if (!rowExhausted(row)) bump(row);
      }
    };

    const statScore = (c, entry) => {
      const stats = entry.stats ?? [];
      let value = 0;
      for (const set of c.lineSets) {
        const index = stats.findIndex((stat) => set.has(stat));
        if (index >= 0) value += (stats.length - index) * 12;
      }
      return value;
    };
    // Earlier rows are worth more. Past row 39 the step shrinks instead of
    // going negative, so a very long list still stays in order.
    const rowBonus = (index) =>
      index < 39 ? 1200 - index * 30 : Math.max(1, 30 - (index - 39) * 0.25);

    const scoreCard = (c, offer) => {
      const { quality, fresh, swap, level, hit } = c;
      if (c.meat) return -1e9;
      if (!hit) return 450 + quality * 8 + level * 2;
      const build = activeBuild;

      if (
        hit.kind === "skill" &&
        hit.entry === AUTO_SKILL &&
        (build?.autoMode === "ignore" || build?.autoMode === "banish")
      ) {
        return 1 + quality * 8;
      }

      if (hit.kind === "skill") {
        const entry = hit.entry;
        const slots = offer.sockets.slots;
        const fill = fresh && slots && slots[0] < slots[1] ? 300 : 0;
        if (!build) {
          return (
            (fresh ? 500 : 300) +
            quality * 8 +
            statScore(c, entry) +
            level * 2 +
            fill
          );
        }
        const req = build.required.indexOf(entry.id);
        if (req >= 0) {
          if (fresh) {
            let value = 1000 - req * 40 + quality * 8 + fill;
            if (build.newOverUpgrades) value += 1500;
            return value;
          }
          const listed = hasMatchingRow(build.skillUpgrades, entry.id, c);
          const row = bestUpgradeRow(build.skillUpgrades, entry.id, c);
          if (listed && !row) return 250 + quality * 8;
          let value =
            (listed ? 700 : 500) -
            req * 30 +
            statScore(c, entry) +
            quality * 8 +
            level * 2;
          if (row) value += rowBonus(row.index);
          return value;
        }
        if (fresh) return 200 + quality * 8;
        const listed = hasMatchingRow(build.skillUpgrades, entry.id, c);
        const row = bestUpgradeRow(build.skillUpgrades, entry.id, c);
        if (listed && !row) return 200 + quality * 8;
        if (row) {
          return (
            800 +
            rowBonus(row.index) +
            statScore(c, entry) +
            quality * 8 +
            level * 2
          );
        }
        return 300 + quality * 8 + statScore(c, entry) + level * 2;
      }

      const best = build ? bestItemRow(c) : null;
      return (
        (best
          ? Math.max(400, 5000 - best.groupIndex * 400 - best.rowIndex * 10)
          : 300) +
        quality * 25 +
        level * 3 +
        (fresh ? 20 : 0) -
        (swap ? 60 : 0)
      );
    };

    const cardMatchesBuild = (c) => {
      const hit = c.hit;
      const build = activeBuild;
      if (!hit || !build) return false;
      if (hit.kind === "skill") {
        if (
          hit.entry === AUTO_SKILL &&
          (build.autoMode === "ignore" || build.autoMode === "banish")
        ) {
          return false;
        }
        if (build.required.includes(hit.entry.id) && c.fresh) return true;
        return !!bestUpgradeRow(build.skillUpgrades, hit.entry.id, c);
      }
      return !!bestItemRow(c);
    };

    // ---------------------------------------------------- picker buttons --
    const REROLL_RE = /re-?roll|rerol|recargar|volver a tirar|重抽|重擲|重掷|刷新/i;
    const FOCUS_RE = /focus|foco|enfocar|專注|专注/i;
    const BANISH_RE = /banish|desterrar|destierro|放逐/i;
    const SKIP_RE = /skip|omitir|saltar|跳過|跳过/i;
    const buttonLabel = (button) =>
      `${button.textContent || ""} ${button.title || ""} ${
        button.getAttribute("aria-label") || ""
      }`;
    const findRerollButton = () => {
      const bar = $("#pk-bar");
      if (!bar || bar.classList.contains("hidden")) return null;
      const buttons = $$(".pk-act", bar).filter((button) => !button.disabled);
      return (
        buttons.find((button) => REROLL_RE.test(buttonLabel(button))) ??
        // A reroll button in a language we do not know: take the first
        // button that is clearly not something else.
        buttons.find((button) => {
          const label = buttonLabel(button);
          return (
            !FOCUS_RE.test(label) && !BANISH_RE.test(label) && !SKIP_RE.test(label)
          );
        }) ??
        null
      );
    };
    const findCardAction = (slot, pattern) =>
      $$(".pk-acts .pk-act", slot).find((button) =>
        pattern.test(buttonLabel(button)),
      ) ?? null;
    const findCardReroll = (slot) => {
      const buttons = $$(".pk-acts .pk-act", slot);
      return (
        buttons.find((button) => REROLL_RE.test(buttonLabel(button))) ??
        buttons.find((button) => {
          const label = buttonLabel(button);
          return !FOCUS_RE.test(label) && !BANISH_RE.test(label);
        }) ??
        null
      );
    };

    // Which kinds of run item are already held. The game may tag a socket
    // with the kind or with the item itself; both are understood.
    const occupiedSlotTypes = (sockets) => {
      const types = new Set();
      const tables = itemTables(cls);
      for (const value of sockets.itemValues) {
        if (!value) continue;
        const raw = lower(value);
        if (SLOT_TYPES.includes(raw)) {
          types.add(raw);
          continue;
        }
        const entry = tables.byRun.get(raw) ?? tables.byIcon.get(raw);
        types.add(itemSlot(entry ?? raw) || raw);
      }
      return types;
    };
    const learnedSkillIds = (sockets) =>
      new Set([...sockets.learnedIds, ...runLearned]);

    const describePick = (c) => {
      const hit = c.hit;
      const build = activeBuild;
      if (!hit) return "unknown card with the best score";
      if (!build) return "no build selected, best score";
      if (hit.kind === "skill") {
        if (
          hit.entry === AUTO_SKILL &&
          (build.autoMode === "ignore" || build.autoMode === "banish")
        ) {
          return "nothing better on offer";
        }
        const req = build.required.indexOf(hit.entry.id);
        if (req >= 0 && c.fresh) return `required skill ${req + 1}`;
        const row = bestUpgradeRow(build.skillUpgrades, hit.entry.id, c);
        if (row) return `skill upgrade priority ${row.index + 1}`;
        return "best of what was offered";
      }
      const best = bestItemRow(c);
      if (best) {
        const group = best.group.name || `group ${best.groupIndex + 1}`;
        return `${group}, priority ${best.rowIndex + 1}`;
      }
      return "best of what was offered";
    };

    /*
     * Decide what to do with the offer on screen. Returns one action:
     *   reroll / card-reroll / banish / focus  - click that button
     *   wait                                   - leave it to the player
     *   pick                                   - take that card
     * With `suggest` set, only "pick" or "wait" come back (nothing is spent).
     */
    const decide = (offer, state, suggest) => {
      const build = activeBuild;
      const { sockets } = offer;
      // A card that is already taken (offers that grant two) is out.
      const cards = offer.cards.filter((c) => !c.chosen);
      const maxRerolls = build ? build.maxRerolls : 3;
      const normalOffer =
        sockets.visible && (sockets.skillsHeader || sockets.itemsHeader);
      const reroll = findRerollButton();
      const skillOffer =
        sockets.skillsHeader || cards.some((c) => c.hit?.kind === "skill");
      const chestOffer =
        !skillOffer && normalOffer && cards.some((c) => c.hit?.kind === "item");
      const itemCards = cards.filter((c) => c.hit?.kind === "item");

      if (build && !suggest) {
        // A deity nobody asked for: reroll just that card.
        if (build.itemRerollDeityWrong && state.cardRerolls < maxRerolls) {
          const deities = itemCards.filter((c) => isDeityEntry(c.hit.entry));
          if (deities.length && !deities.some((c) => bestItemRow(c))) {
            for (const c of deities) {
              const button = findCardReroll(c.slot);
              if (button && !button.disabled) {
                return {
                  type: "card-reroll",
                  card: c,
                  button,
                  why: "that deity is not on the priority list",
                };
              }
            }
          }
        }

        if (skillOffer) {
          const required = build.required.filter(Boolean);
          if (reroll && required.length && state.fullRerolls < maxRerolls) {
            const isRequired = (c) =>
              c.hit?.kind === "skill" && required.includes(c.hit.entry.id);
            const hasNew = cards.some((c) => isRequired(c) && c.fresh);
            const hasUpgrade = cards.some((c) => isRequired(c) && !c.fresh);
            const learnedNow = learnedSkillIds(sockets);
            const missing = required.some((id) => !learnedNow.has(id));
            const full = !!sockets.slots && sockets.slots[0] >= sockets.slots[1];
            let why = "";
            if (build.rerollNoSkill && missing && !full && !hasNew) {
              why = "no required skill on offer";
            } else if (build.rerollNoUpgrade && !hasUpgrade && !hasNew) {
              why = "no upgrade for a required skill on offer";
            }
            if (why) return { type: "reroll", button: reroll, why };
          }
        } else if (chestOffer) {
          const first = (build.itemGroups ?? [])[0];
          const wanted = (first?.rows ?? []).filter((row) => !rowExhausted(row));
          const mandatory = !!first?.mandatory && wanted.length > 0;
          const bestRows = itemCards.map((c) => bestItemRow(c));
          const anyPriority = bestRows.some(Boolean);
          const mandatoryMatch = bestRows.some((best) => best?.groupIndex === 0);

          if (mandatory && !mandatoryMatch) {
            if (build.mandatoryCardReroll && state.cardRerolls < maxRerolls) {
              const types = new Set(wanted.map((row) => itemSlot(row.name)));
              for (const c of itemCards) {
                const type = itemSlot(c.hit.entry);
                if (!type || !types.has(type)) continue;
                const button = findCardReroll(c.slot);
                if (button && !button.disabled) {
                  return {
                    type: "card-reroll",
                    card: c,
                    button,
                    why: "mandatory item not on offer",
                  };
                }
              }
            }
            if (
              reroll &&
              build.mandatoryFullReroll &&
              state.fullRerolls < maxRerolls
            ) {
              return {
                type: "reroll",
                button: reroll,
                why: "mandatory item not on offer",
              };
            }
          }
          if (
            reroll &&
            build.itemRerollNoPriority &&
            !anyPriority &&
            state.fullRerolls < maxRerolls
          ) {
            return {
              type: "reroll",
              button: reroll,
              why: "nothing from the priority list on offer",
            };
          }
        }

        if (
          build.autoMode === "banish" &&
          state.banish < 2 &&
          nowMs() - lastBanishAt > 1200
        ) {
          const autoCard = cards.find((c) => c.hit?.entry === AUTO_SKILL);
          const button = autoCard
            ? findCardAction(autoCard.slot, BANISH_RE)
            : null;
          if (button && !button.disabled) {
            return { type: "banish", card: autoCard, button };
          }
        }
      }

      if (
        opts.randomAfterRerolls &&
        !suggest &&
        build &&
        normalOffer &&
        state.fullRerolls >= maxRerolls &&
        cards.some((c) => c.hit) &&
        !cards.some(cardMatchesBuild)
      ) {
        const pool = cards.filter((c) => c.hit && !c.chosen);
        if (pool.length) {
          return {
            type: "pick",
            card: pool[Math.floor(Math.random() * pool.length)],
            why: "random pick after reroll limit",
          };
        }
      }

      if (
        build?.manualFallback &&
        normalOffer &&
        cards.some((c) => c.hit) &&
        !cards.some(cardMatchesBuild)
      ) {
        return { type: "wait" };
      }

      let best = null;
      let why = "";
      if (build?.fillSlotsFirst && chestOffer && !reroll) {
        const cardRerollLeft = cards.some((c) => {
          const button = findCardReroll(c.slot);
          return !!button && !button.disabled;
        });
        const occupied = cardRerollLeft ? null : occupiedSlotTypes(sockets);
        if (occupied && occupied.size < 5) {
          const fresh = [];
          const upgrades = [];
          for (const c of itemCards) {
            const type = itemSlot(c.hit.entry);
            const row = type ? bestItemRow(c) : null;
            if (!row) continue;
            const entry = { c, rank: row.groupIndex * 1000 + row.rowIndex };
            (occupied.has(type) ? upgrades : fresh).push(entry);
          }
          if (fresh.length && upgrades.length) {
            const lowest = (list) =>
              list.reduce((a, b) => (a.rank <= b.rank ? a : b));
            const bestNew = lowest(fresh);
            if (bestNew.rank > lowest(upgrades).rank) {
              best = bestNew.c;
              why = "fills an empty item slot";
            }
          }
        }
      }
      if (!best) {
        let bestValue = -Infinity;
        for (const c of cards) {
          c.score = scoreCard(c, offer);
          if (c.score > bestValue) {
            bestValue = c.score;
            best = c;
          }
        }
      }
      if (!best) return { type: "none" };

      const hit = best.hit;
      const wantsFocus =
        !!hit &&
        !!build &&
        ((hit.entry === AUTO_SKILL && build.autoMode === "focus") ||
          (hit.kind === "skill" && build.focusSkills.includes(hit.entry.id)) ||
          (hit.kind === "item" && build.focusItems.includes(hit.entry.id)));
      if (
        wantsFocus &&
        !suggest &&
        !state.focused.has(best.sig) &&
        nowMs() - lastFocusAt > 1200
      ) {
        const button = findCardAction(best.slot, FOCUS_RE);
        if (button && !button.disabled) {
          return { type: "focus", card: best, button };
        }
      }
      return { type: "pick", card: best, why: why || describePick(best) };
    };

    // =====================================================================
    // 5. Picker
    // =====================================================================
    const ACTION_GAP_MS = 800; // pause between two actions, as in 1.x
    const SETTLE_MS = 350; // the cards must be unchanged for this long ...
    const SETTLE_MAX_MS = 1600; // ... but never wait longer than this
    const REROLL_GRACE_MS = 2500; // a reroll may close the picker for a moment
    const CHOSEN_STUCK_MS = 2500; // a taken card that stays on screen
    const PICK_CONFIRM_MS = 250;
    const PICK_SETTLE_MS = 2000;

    /*
     * One "session" is one offer: from the moment the picker shows cards
     * until a card is taken. Reroll counts and "leave it to me" belong to
     * the session, so every new offer starts from zero.
     */
    let session = null;
    let lastFocusAt = 0;
    let lastBanishAt = 0;
    let pendingPick = null;
    let suggestedSlot = null;
    let observedPicker = null;
    let pickerObserver = null;
    const recordedSlots = new WeakSet();

    const newSession = (sig) => ({
      sig,
      sigSince: nowMs(),
      waitSince: nowMs(),
      fullRerolls: 0,
      cardRerolls: 0,
      banish: 0,
      focused: new Set(),
      committed: new Set(),
      pickedSlots: new Set(),
      waitingSig: null,
      pickSig: null,
      chosenSince: 0,
      lastRerollAt: 0,
      lastActionAt: 0,
      offer: null,
    });
    const pickerIsOpen = (picker = $("#picker")) =>
      !!picker &&
      !picker.classList.contains("hidden") &&
      !picker.classList.contains("closing");

    const clearSuggestion = () => {
      if (suggestedSlot) {
        try {
          suggestedSlot.classList.remove("ro-auto-suggested");
        } catch {}
        suggestedSlot = null;
      }
      if (hintMode === "suggest") hideHint();
    };
    const endSession = () => {
      session = null;
      clearSuggestion();
      hideHint();
    };

    const resolveHit = (c) => {
      const raw = identifyCard(c, cls);
      c.detected = raw;
      c.hit =
        raw && raw.entry.learned && !buildUses(activeBuild, raw.entry.id)
          ? null
          : raw;
      return c;
    };

    // A card was taken (by us or by the player): count it and log it.
    const commitPick = (c, ours, why) => {
      if (session) {
        // The same card is never counted twice within one offer, however
        // the game redraws it.
        if (session.committed.has(c.sig)) return;
        session.committed.add(c.sig);
        session.pickedSlots.add(c.slot);
        if (session.pickSig == null) session.pickSig = session.sig;
      }
      recordPick(c);
      if (c.hit?.kind === "skill" && c.fresh && c.hit.entry !== AUTO_SKILL) {
        runLearned.add(c.hit.entry.id);
      }
      if (ours) {
        runStats.picks += 1;
        logEvent("pick", `Picked ${cardLabel(c)} — ${why}`);
      } else {
        runStats.manualPicks += 1;
        logEvent("pick", `You picked ${cardLabel(c)}`, { toast: false });
      }
    };

    const scanChosen = (picker) => {
      for (const el of picker.querySelectorAll(
        ".pk-slot.chosen, .pk-card.chosen",
      )) {
        const slot = el.closest(".pk-slot") || el;
        if (recordedSlots.has(slot)) continue;
        recordedSlots.add(slot);
        let c =
          session?.offer?.cards.find((entry) => entry.slot === slot) ?? null;
        if (!c) {
          const cardEl = slot.matches(".pk-card")
            ? slot
            : slot.querySelector(".pk-card");
          if (!cardEl) continue;
          c = resolveHit(readCard(cardEl));
        }
        // Ours if it is the card we just clicked, even when the game drew
        // a fresh element for it.
        const pending = pendingPick;
        const mine =
          !!pending && (pending.c.slot === slot || pending.c.sig === c.sig);
        if (pending) {
          pending.recorded = true;
          pendingPick = null;
        }
        commitPick(mine ? pending.c : c, mine, mine ? pending.why : "");
      }
    };

    // Our own click normally shows up as a "chosen" card. If the game closes
    // the picker without marking one, the click still counted.
    const settlePendingPick = (open) => {
      const pick = pendingPick;
      if (!pick) return;
      if (pick.recorded || nowMs() - pick.at > PICK_SETTLE_MS) {
        pendingPick = null;
        return;
      }
      if (!open || !pick.c.slot.isConnected) {
        pendingPick = null;
        pick.recorded = true;
        recordedSlots.add(pick.c.slot);
        commitPick(pick.c, true, pick.why);
      }
    };

    const watchPicker = (picker) => {
      if (picker === observedPicker) return;
      try {
        pickerObserver?.disconnect();
      } catch {}
      pickerObserver = null;
      observedPicker = picker;
      if (!picker || typeof MutationObserver !== "function") return;
      try {
        pickerObserver = new MutationObserver(
          guard("picker-observer", () => {
            if (!picker.classList.contains("hidden")) scanChosen(picker);
          }),
        );
        pickerObserver.observe(picker, {
          subtree: true,
          attributes: true,
          attributeFilter: ["class"],
        });
      } catch (error) {
        noteError("picker-observer", error);
      }
    };

    let audioContext = null;
    const playAlert = () => {
      if (!opts.manualSound) return;
      try {
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
          return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioContext = audioContext || new Ctx();
        if (audioContext.state === "suspended") audioContext.resume();
        const start = audioContext.currentTime;
        for (const [offset, frequency] of [
          [0, 880],
          [0.18, 1175],
        ]) {
          const tone = audioContext.createOscillator();
          const gain = audioContext.createGain();
          tone.type = "sine";
          tone.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start + offset);
          gain.gain.exponentialRampToValueAtTime(0.12, start + offset + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
          tone.connect(gain);
          gain.connect(audioContext.destination);
          tone.start(start + offset);
          tone.stop(start + offset + 0.18);
        }
      } catch {}
    };

    const showSuggestion = (offer) => {
      const action = decide(offer, session, true);
      if (action.type === "wait") {
        clearSuggestion();
        showHint("No prioritized option — choose manually.", "wait");
        return;
      }
      if (action.type !== "pick") {
        clearSuggestion();
        return;
      }
      const slot = action.card.slot;
      if (suggestedSlot && suggestedSlot !== slot) {
        suggestedSlot.classList.remove("ro-auto-suggested");
      }
      suggestedSlot = slot;
      slot.classList.add("ro-auto-suggested");
      showHint(`Suggested: ${cardLabel(action.card)} — ${action.why}`, "suggest");
    };

    const perform = (action, offer) => {
      const t = nowMs();
      switch (action.type) {
        case "reroll":
          session.fullRerolls += 1;
          session.lastRerollAt = t;
          session.lastActionAt = t;
          runStats.rerolls += 1;
          logEvent("reroll", `Rerolled the offer — ${action.why}`);
          activate(action.button);
          return;
        case "card-reroll":
          session.cardRerolls += 1;
          session.lastRerollAt = t;
          session.lastActionAt = t;
          runStats.cardRerolls += 1;
          logEvent("reroll", `Rerolled ${cardLabel(action.card)} — ${action.why}`);
          activate(action.button);
          return;
        case "banish":
          lastBanishAt = t;
          session.banish += 1;
          session.lastRerollAt = t;
          session.lastActionAt = t;
          runStats.banish += 1;
          logEvent("banish", `Banished ${cardLabel(action.card)}`);
          activate(action.button);
          return;
        case "focus":
          lastFocusAt = t;
          session.focused.add(action.card.sig);
          session.lastActionAt = t;
          runStats.focus += 1;
          logEvent("focus", `Focus perk on ${cardLabel(action.card)}`);
          activate(action.button);
          return;
        case "wait":
          session.waitingSig = offer.sig;
          runStats.waits += 1;
          showHint("No prioritized option — choose manually.", "wait");
          playAlert();
          logEvent("wait", "No prioritized option — waiting for your pick", {
            toast: false,
          });
          return;
        case "pick": {
          const c = action.card;
          session.pickSig = offer.sig;
          session.lastActionAt = t;
          pendingPick = { c, at: t, why: action.why, recorded: false };
          const needsConfirm = !!c.slot.querySelector(".pk-back");
          const index = offer.cards.indexOf(c);
          if (index >= 0 && index < 9) {
            // A number key goes to a focused input (usually the chat box), not
            // to the picker, so leave the input first.
            if (isTypingTarget(document.activeElement)) {
              document.activeElement.blur();
            }
            const key = String(index + 1);
            sendMoveKey("keydown", key);
            sendMoveKey("keyup", key);
          } else {
            activate(c.card);
          }
          if (needsConfirm) {
            setTimeout(
              guard("confirm", () => {
                activate(c.slot.querySelector("[data-yes]"));
              }),
              PICK_CONFIRM_MS,
            );
          }
          return;
        }
        default:
      }
    };

    const tickPicker = () => {
      const picker = $("#picker");
      watchPicker(picker);
      const open = pickerIsOpen(picker);
      if (picker && !picker.classList.contains("hidden")) scanChosen(picker);
      settlePendingPick(open);
      if (!open) {
        clearSuggestion();
        hideHint();
        // Closed after a card was taken: the offer is over. A reroll can
        // also blink the picker shut, and that is still the same offer.
        if (
          session &&
          (session.committed.size > 0 ||
            nowMs() - session.lastRerollAt > REROLL_GRACE_MS)
        ) {
          endSession();
        }
        return;
      }
      const cardEls = $$("#pk-cards .pk-card", picker);
      if (!cardEls.length) return;

      const offer = readOffer(picker, cardEls);
      const t = nowMs();
      for (const c of offer.cards) {
        if (!c.chosen) recordedSlots.delete(c.slot);
      }
      if (!session) {
        session = newSession(offer.sig);
      } else if (!offer.anyChosen) {
        // New cards after a card was taken, without the picker closing:
        // a new offer. Either the cards read differently, or the taken
        // card is gone from the page.
        const taken = session.committed.size > 0;
        const changed =
          session.pickSig != null && offer.sig !== session.pickSig;
        const takenGone = ![...session.pickedSlots].some(
          (slot) => slot.isConnected,
        );
        if (taken && (changed || takenGone)) {
          hideHint();
          session = newSession(offer.sig);
        }
      }
      if (offer.sig !== session.sig) {
        // Start of a new "still changing" stretch, unless one is running.
        if (t - session.sigSince >= SETTLE_MS) session.waitSince = t;
        session.sig = offer.sig;
        session.sigSince = t;
      }
      session.offer = offer;
      // Cards that never stop changing (a countdown in the text, say) must
      // not hold things up for good.
      const settled =
        t - session.sigSince >= SETTLE_MS ||
        t - session.waitSince >= SETTLE_MAX_MS;

      if (!enabled || !priorityEnabled) {
        clearSuggestion();
        hideHint();
        return;
      }
      if (uiBlocksPicking()) return;
      if (offer.anyChosen) {
        if (!session.chosenSince) session.chosenSince = t;
        if (t - session.chosenSince < CHOSEN_STUCK_MS) return;
      } else {
        session.chosenSince = 0;
      }

      // "Let me choose" holds until the cards change or one is taken.
      if (session.waitingSig === offer.sig) {
        showHint("No prioritized option — choose manually.", "wait");
        return;
      }
      if (session.waitingSig) {
        session.waitingSig = null;
        hideHint();
      }
      if (t - session.lastActionAt < ACTION_GAP_MS) return;

      if (opts.suggestOnly) {
        if (settled) showSuggestion(offer);
        return;
      }
      clearSuggestion();
      const asking = $(".pk-slot.asking", picker);
      if (asking) {
        session.lastActionAt = t;
        activate(asking.querySelector("[data-yes]"));
        return;
      }
      if (!settled) return;
      perform(decide(offer, session, false), offer);
    };

    // =====================================================================
    // 6. Movement and loot
    // =====================================================================
    const MANUAL_PAUSE_MS = 4000;
    // Keys the add-on replays itself arrive as trusted input, so they are
    // told apart from the player only by how recently they were sent.
    const SELF_KEY_MS = 300;
    // A press the worker could not deliver is retried on this cadence.
    const KEY_RETRY_MS = 1500;
    const MOVE_KEYS = new Set([
      "w", "a", "s", "d", "W", "A", "S", "D",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    ]);
    // How close to a coordinate counts as "there", in map units.
    const MOVE_ARRIVE = 2.5;
    // Stay this long without getting closer before deciding the hero is stuck.
    const MOVE_STUCK_MS = 3000;
    const MOVE_CLICK_MS = 120;
    const moveState = {
      angle: Math.random() * Math.PI * 2,
      zig: 1,
      nextAt: 0,
      held: false,
      heldAt: 0,
      manualUntil: 0,
      selfKeyAt: 0,
      lootLogged: "",
      lootIssue: "",
      lootKeys: new Set(),
      lootKeyAt: 0,
      // Coordinate path: the centre the pattern is built around, the point
      // being walked to, and the point to come back to after looting.
      center: null,
      target: null,
      returnTo: null,
      lootActive: false,
      lootTarget: null,
      lootScanAt: 0,
      lootProgress: null,
      lootIgnoreUntil: 0,
      progress: null,
      legAt: 0,
      clickAt: 0,
    };

    // Where to click next, as an offset from the middle of the screen. This is
    // only used when the minimap coordinates are not available.
    // The hero stands in the middle, so the offset is a walking direction.
    const nextMoveOffset = (pattern, radius) => {
      const state = moveState;
      switch (pattern) {
        case "zigzag":
          // There and back, with the line slowly turning.
          state.angle += Math.PI + 0.2;
          break;
        case "random":
          state.angle = Math.random() * Math.PI * 2;
          radius *= 0.5 + Math.random() * 0.5;
          break;
        default:
          state.angle += 0.85;
      }
      return [Math.cos(state.angle) * radius, Math.sin(state.angle) * radius];
    };
    // The minimap title shows the hero's map position as "(x, y)".
    const mapCoords = () => {
      const label = $("#minimap-coords");
      if (!label) return null;
      const match = text(label).match(/\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
      if (!match) return null;
      return { x: Number(match[1]), y: Number(match[2]) };
    };
    const pointsApart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    // Convert a coordinate direction into held movement keys. On the map,
    // d/a walk along the first coordinate and w/s along the second one.
    // A dead zone keeps almost-axis-aligned directions from pressing both
    // keys at once.
    const wasdKeysFor = (dx, dy) => {
      const dead = Math.max(0.8, opts.move.step * 0.05);
      const keys = new Set();
      if (dx > dead) keys.add("d");
      else if (dx < -dead) keys.add("a");
      if (dy > dead) keys.add("w");
      else if (dy < -dead) keys.add("s");
      return keys;
    };
    // Screen-space fallback for the same thing, used without coordinates.
    const screenKeysFor = (dx, dy, radius) => {
      const dead = Math.max(1, radius * 0.35);
      const keys = new Set();
      if (dx > dead) keys.add("d");
      else if (dx < -dead) keys.add("a");
      if (dy > dead) keys.add("s");
      else if (dy < -dead) keys.add("w");
      return keys;
    };
    const resetMovePath = () => {
      moveState.angle = Math.random() * Math.PI * 2;
      moveState.zig = 1;
      moveState.nextAt = 0;
      moveState.center = null;
      moveState.target = null;
      moveState.returnTo = null;
      moveState.lootActive = false;
      moveState.lootTarget = null;
      moveState.lootScanAt = 0;
      moveState.lootProgress = null;
      moveState.lootIgnoreUntil = 0;
      moveState.progress = null;
      moveState.legAt = 0;
      moveState.clickAt = 0;
    };
    // The next point of the selected pattern, around the current centre.
    const nextWaypoint = () => {
      if (!moveState.center) return null;
      const step = opts.move.step;
      let angle = moveState.angle;
      let sign = 1;
      if (opts.move.pattern === "random") {
        angle = Math.random() * Math.PI * 2;
      } else if (opts.move.pattern === "zigzag") {
        // Go there, then back, while the line slowly turns.
        moveState.zig *= -1;
        moveState.angle += 0.2;
        angle = moveState.angle;
        sign = moveState.zig;
      } else {
        angle = moveState.angle + 0.85;
      }
      moveState.angle = angle;
      return {
        x: Math.round(moveState.center.x + Math.cos(angle) * step * sign),
        y: Math.round(moveState.center.y + Math.sin(angle) * step * sign),
      };
    };
    const ignoreLoot = () => {
      moveState.lootActive = false;
      moveState.lootTarget = null;
      moveState.lootProgress = null;
      moveState.returnTo = null;
      moveState.progress = null;
    };
    // A stuck hero gets a new centre where it stands and a target behind it,
    // so the next step pulls it out of the corner instead of into it again.
    const unstickFrom = (coords, target) => {
      const dx = target.x - coords.x;
      const dy = target.y - coords.y;
      const length = Math.hypot(dx, dy) || 1;
      const step = opts.move.step;
      moveState.center = { x: coords.x, y: coords.y };
      moveState.angle = Math.atan2(-dy / length, -dx / length);
      moveState.zig = 1;
      moveState.target = {
        x: Math.round(coords.x - (dx / length) * step),
        y: Math.round(coords.y - (dy / length) * step),
      };
      ignoreLoot();
      moveState.nextAt = 0;
      logEvent("move", "Stuck: new centre, turning back", { toast: false });
    };
    const checkStuck = (coords, target, t) => {
      const distance = pointsApart(coords, target);
      const progress = moveState.progress;
      if (!progress) {
        moveState.progress = { distance, at: t };
        return false;
      }
      if (distance <= progress.distance - 1) {
        progress.distance = distance;
        progress.at = t;
        return false;
      }
      if (t - progress.at < MOVE_STUCK_MS) return false;
      unstickFrom(coords, target);
      return true;
    };
    // The same idea for loot. A chest or magnet behind a wall must not keep
    // the hero pinned forever; give up for a while and walk back. There is no
    // coordinate target here, so any real movement counts as progress.
    const checkLootStuck = (coords, loot, t) => {
      if (!coords) return false;
      const progress = moveState.lootProgress;
      if (!progress || progress.sig !== loot.sig) {
        moveState.lootProgress = {
          sig: loot.sig,
          x: coords.x,
          y: coords.y,
          at: t,
        };
        return false;
      }
      if (Math.hypot(coords.x - progress.x, coords.y - progress.y) >= 1) {
        progress.x = coords.x;
        progress.y = coords.y;
        progress.at = t;
        return false;
      }
      if (t - progress.at < MOVE_STUCK_MS) return false;
      moveState.lootProgress = null;
      return true;
    };

    const gameDialogOpen = () => {
      const dialog = $("#npc-dialog");
      return !!dialog && !dialog.classList.contains("hidden");
    };
    const manualControl = () => {
      const t = nowMs();
      // A missed "button up" must not park the hero for good.
      if (moveState.held && t - moveState.heldAt > 20000) moveState.held = false;
      return moveState.held || t < moveState.manualUntil;
    };

    // ---------------------------------------------------- minimap targets --
    const clusterPoints = (points, cell) => {
      if (!points.length) return [];
      const grid = new Map();
      for (const point of points) {
        grid.set(`${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`, point);
      }
      const seen = new Set();
      const out = [];
      for (const point of points) {
        const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;
        if (seen.has(key)) continue;
        const stack = [point];
        seen.add(key);
        let sx = 0;
        let sy = 0;
        let count = 0;
        while (stack.length) {
          const current = stack.pop();
          sx += current.x;
          sy += current.y;
          count += 1;
          const cx = Math.floor(current.x / cell);
          const cy = Math.floor(current.y / cell);
          for (let ox = -1; ox <= 1; ox += 1) {
            for (let oy = -1; oy <= 1; oy += 1) {
              const nextKey = `${cx + ox},${cy + oy}`;
              if (seen.has(nextKey) || !grid.has(nextKey)) continue;
              seen.add(nextKey);
              stack.push(grid.get(nextKey));
            }
          }
        }
        out.push({ x: sx / count, y: sy / count, count });
      }
      return out;
    };
    const hudNumber = (selector) => {
      const match = text($(selector)).match(/\d[\d.,]*/);
      return match ? Number(match[0].replace(/[.,]/g, "")) : NaN;
    };
    const canAffordChest = () => {
      const zeny = hudNumber("#zeny-text");
      const cost = hudNumber("#chest-cost");
      if (!Number.isFinite(zeny) || !Number.isFinite(cost) || cost <= 0) {
        return true;
      }
      return zeny >= cost;
    };
    const clickMoveOffset = (dx, dy) => {
      const canvas = $("#stage canvas.ro-cursor");
      if (!canvas) return false;
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return false;
      trustedClick(canvas, dx, dy);
      return true;
    };
    // Trusted mouse clicks only reach the active tab. In the background the
    // same movement goes through the game keys instead.
    const canUseMouse = () => !document.hidden && document.hasFocus();
    const steerToward = (coords, target, box, t) => {
      const dx = target.x - coords.x;
      const dy = target.y - coords.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.01) return;
      if (opts.move.wasd || !canUseMouse()) {
        setLootKeys(wasdKeysFor(dx, dy));
        return;
      }
      // Clicking a little ahead of the hero, over and over, gives the same
      // closed loop as holding a key, without depending on a screen radius.
      if (t - moveState.clickAt < MOVE_CLICK_MS) return;
      const reach = clamp(distance / Math.max(1, opts.move.step), 0, 1);
      const radius = Math.min(box.width, box.height) * (0.02 + 0.06 * reach);
      clickMoveOffset((dx / distance) * radius, -(dy / distance) * radius);
      moveState.clickAt = t;
      releaseLootKeys();
    };
    const reachedTarget = (t) => {
      moveState.target = null;
      moveState.progress = null;
      // A step may take longer than the chosen pace; in that case the next
      // one starts at once instead of adding a second pause.
      moveState.nextAt = moveState.legAt + opts.move.interval;
      releaseLootKeys();
    };
    const noteLootIssue = (message) => {
      if (moveState.lootIssue === message) return;
      moveState.lootIssue = message;
      if (message) logEvent("move", message, { toast: false });
    };
    const minimapLoot = () => {
      if (
        !opts.move.collectChests &&
        !opts.move.collectMagnets &&
        !opts.move.collectItems
      ) {
        noteLootIssue("");
        return null;
      }
      const mini = $("#minimap");
      const canvas = $("#minimap canvas");
      if (!mini || mini.classList.contains("hidden")) {
        noteLootIssue("Ground loot: minimap is hidden.");
        return null;
      }
      if (!canvas || !canvas.width || !canvas.height) {
        noteLootIssue("Ground loot: minimap canvas is missing.");
        return null;
      }
      let ctx = null;
      try {
        ctx = canvas.getContext("2d", { willReadFrequently: true });
      } catch {
        noteLootIssue("Ground loot: the minimap cannot be read.");
        return null;
      }
      if (!ctx) {
        noteLootIssue("Ground loot: the minimap has no 2D context.");
        return null;
      }
      let image = null;
      try {
        image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        noteLootIssue(
          "Ground loot: the minimap is not readable (tainted canvas).",
        );
        return null;
      }
      noteLootIssue("");
      const w = canvas.width;
      const h = canvas.height;
      const data = image.data;
      const step = Math.max(1, Math.round(w / 220));
      const player = [];
      const chests = [];
      const magnets = [];
      const items = [];
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const at = (y * w + x) * 4;
          if (data[at + 3] < 180) continue;
          const r = data[at];
          const g = data[at + 1];
          const b = data[at + 2];
          if (
            Math.abs(r - 192) <= 16 &&
            Math.abs(g - 24) <= 16 &&
            Math.abs(b - 42) <= 18
          ) {
            player.push({ x, y });
          } else if (
            opts.move.collectChests &&
            r >= 240 &&
            g >= 180 &&
            g <= 220 &&
            b >= 34 &&
            b <= 92
          ) {
            chests.push({ x, y });
          } else if (
            opts.move.collectMagnets &&
            r >= 240 &&
            g >= 44 &&
            g <= 78 &&
            b >= 54 &&
            b <= 98
          ) {
            magnets.push({ x, y });
          } else if (opts.move.collectItems) {
            for (const entry of ITEM_QUALITY_RGB) {
              if (entry.rank < opts.move.itemRarity) continue;
              if (nearRgb(r, g, b, entry.rgb)) {
                items.push({ x, y, rank: entry.rank });
                break;
              }
            }
          }
        }
      }
      const foundPlayer = clusterPoints(player, step).sort(
        (a, b) => b.count - a.count,
      )[0];
      const playerPos = foundPlayer || { x: w / 2, y: h / 2 };
      // The game checks pickups against a point 20 world units above the
      // hero, so aim slightly below each icon. Otherwise the hero walks
      // around a chest and only touches its pickup circle from one side.
      // ponytail: constant nudge in icon pixels; scale it by the map
      // area/zoom only if some map still refuses to pick up.
      const aimDown = 3.5 * Math.min(2, window.devicePixelRatio || 1);
      const targets = [];
      const affordable = canAffordChest();
      if (opts.move.collectChests && affordable) {
        for (const cluster of clusterPoints(chests, step)) {
          if (cluster.count < 3 || cluster.count > 600) continue;
          const y = cluster.y + aimDown;
          const distance = Math.hypot(cluster.x - playerPos.x, y - playerPos.y);
          if (distance < 0.5) continue;
          targets.push({
            kind: "chest",
            x: cluster.x,
            y,
            distance,
            player: playerPos,
            sig: "chest",
          });
        }
      }
      if (opts.move.collectMagnets) {
        for (const cluster of clusterPoints(magnets, step)) {
          if (cluster.count < 2 || cluster.count > 600) continue;
          const y = cluster.y + aimDown;
          const distance = Math.hypot(cluster.x - playerPos.x, y - playerPos.y);
          if (distance < 0.5) continue;
          targets.push({
            kind: "magnet",
            x: cluster.x,
            y,
            distance,
            player: playerPos,
            sig: "magnet",
          });
        }
      }
      if (opts.move.collectItems) {
        const byRank = new Map();
        for (const point of items) {
          if (!byRank.has(point.rank)) byRank.set(point.rank, []);
          byRank.get(point.rank).push(point);
        }
        for (const [rank, points] of byRank) {
          for (const cluster of clusterPoints(points, step)) {
            if (cluster.count < 2 || cluster.count > 600) continue;
            const y = cluster.y + aimDown;
            const distance = Math.hypot(cluster.x - playerPos.x, y - playerPos.y);
            if (distance < 0.5) continue;
            targets.push({
              // ponytail: a boss dot is the same orange as a legendary drop,
              // so Legendary may target a boss. Fine until it bites.
              kind: `${QUALITY_NAMES[rank]} item`,
              x: cluster.x,
              y,
              distance,
              player: playerPos,
              sig: `item:${rank}`,
            });
          }
        }
      }
      if (!targets.length) return null;
      targets.sort((a, b) => a.distance - b.distance);
      return targets[0];
    };
    let minimapZoomDone = false;
    let minimapZoomInFlight = false;
    const ensureMinimapZoom = () => {
      if (minimapZoomDone || minimapZoomInFlight || !runActive) return;
      if (
        !opts.move.collectChests &&
        !opts.move.collectMagnets &&
        !opts.move.collectItems
      )
        return;
      const mini = $("#minimap");
      if (!mini || mini.classList.contains("hidden")) return;
      const button =
        $(".mm-zoom > button:nth-child(2)") ??
        $('.mm-zoom [data-zoom="in"]');
      if (!button) return;
      // The game clamps zoom at the highest level, so an extra click is
      // harmless. Click once, then again only after the first call returned:
      // both calls target the same element, and the invoke selector is a
      // temporary attribute that a second call would overwrite before the
      // first one is evaluated.
      minimapZoomInFlight = true;
      let clicks = 0;
      let failed = false;
      const next = (ok) => {
        if (!ok) failed = true;
        if (failed) {
          minimapZoomInFlight = false; // retried on the next tick
          return;
        }
        clicks += 1;
        if (clicks < 2) {
          activate(button, next);
          return;
        }
        minimapZoomInFlight = false;
        minimapZoomDone = true;
        logEvent("move", "Minimap zoomed in for ground loot.", {
          toast: false,
        });
      };
      activate(button, next);
    };

    const noteLootTarget = (target) => {
      const sig = target?.sig ?? "";
      if (sig === moveState.lootLogged) return;
      if (sig) {
        logEvent("move", `Heading to ${target.kind} on the minimap`, {
          toast: false,
        });
      } else if (moveState.lootLogged) {
        logEvent("move", "Ground loot target gone", { toast: false });
      }
      moveState.lootLogged = sig;
    };
    // A synthetic KeyboardEvent is always flagged isTrusted: false, and that
    // flag cannot be forged from script. The add-on's service worker instead
    // replays presses through the browser's own input pipeline, which the page
    // sees as hardware input. That is the only path: when it is unavailable
    // (Firefox, DevTools attached, old build) nothing is pressed at all rather
    // than falling back to an event the page can tell apart.
    const keyQueue = [];
    let keyInFlight = false;
    let keyRetryTimer = 0;
    // null until the first press, then true (trusted) or false (unavailable).
    let keyPathState = null;
    let canReplayKeys = false;
    try {
      canReplayKeys =
        typeof chrome !== "undefined" &&
        !!chrome.runtime?.id &&
        typeof chrome.runtime.sendMessage === "function";
    } catch {}

    // A message can fail with "The message port closed before a response was
    // received" when Chrome has just unloaded or started the service worker.
    // That one is worth a second try; the worker answers every call or reports
    // a timeout, so a failure that survives the retry is a real one.
    const sendToWorker = (message, retries = 1) =>
      new Promise((resolve) => {
        const attempt = (left) => {
          const finish = (error, reply) => {
            if ((error || !reply) && left > 0) {
              console.warn(
                "[roa] retrying",
                message.type,
                error?.message ?? "no reply",
              );
              setTimeout(() => attempt(left - 1), 200);
              return;
            }
            const ok = !error && !!reply?.ok;
            const reason = error?.message || reply?.reason || "no reply";
            const build = reply?.build ?? "unreachable";
            if (!ok) {
              console.warn("[roa] input failed", message.type, reason, build);
            }
            resolve({
              ok,
              reason: ok ? reason : `${reason} [worker ${build}]`,
              build,
            });
          };
          try {
            chrome.runtime.sendMessage(message, (reply) => {
              finish(chrome.runtime.lastError, reply);
            });
          } catch (error) {
            finish(error);
          }
        };
        attempt(retries);
      });

    // Say which worker build answered, and warn when the old worker is still
    // loaded (it has no ping, so the message port closes with no reply).
    setTimeout(() => {
      sendToWorker({ type: "trusted-ping" }, 2).then((result) => {
        logEvent(
          "info",
          result.ok
            ? `Input worker ${result.build ?? "unknown"} ready.`
            : `Input worker unavailable (${result.reason}). Fully quit and restart the browser to load the new worker.`,
          { toast: !result.ok },
        );
      });
    }, 500);

    const noteKeyPath = (ok, reason = "") => {
      if (keyPathState === ok) return;
      keyPathState = ok;
      logEvent(
        "move",
        ok
          ? "Game actions are sent through the debugger."
          : `Debugger input unavailable: movement keys and card actions are idle.${
              reason ? ` (${reason})` : ""
            }`,
        { toast: false },
      );
    };

    // A lost release would leave the game holding the key, so a failed keyup
    // goes back to the front of the queue and is retried until it lands.
    const failedKey = (type, key, reason) => {
      noteKeyPath(false, reason);
      if (type !== "keyup") return false;
      keyQueue.unshift({ type, key });
      retryKeysLater();
      return true;
    };

    const retryKeysLater = () => {
      if (keyRetryTimer) return;
      keyRetryTimer = setTimeout(() => {
        keyRetryTimer = 0;
        // A press may still be on its way; look again on the next turn.
        if (keyInFlight) {
          retryKeysLater();
          return;
        }
        pumpKeys();
      }, KEY_RETRY_MS);
    };

    // Replaying takes a message round trip, so presses wait in a queue to
    // stay in order (a keyup must never overtake its keydown).
    const pumpKeys = () => {
      if (keyInFlight || !keyQueue.length) return;
      if (!canReplayKeys) {
        keyQueue.length = 0;
        return;
      }
      const { type, key, target, selector, onDone } = keyQueue.shift();
      keyInFlight = true;
      moveState.selfKeyAt = nowMs();
      const finish = (ok, reason) => {
        keyInFlight = false;
        noteKeyPath(ok, reason);
        pumpKeys();
      };
      if (type === "invoke") {
        const done = (result) => {
          target?.removeAttribute("data-roa-invoke");
          onDone?.(result.ok);
          finish(result.ok, result.reason);
        };
        if (!target?.isConnected || target.disabled) {
          // Not an input failure, so the shared path stays healthy, but the
          // caller is told the action did not happen (the zoom re-queries a
          // fresh button on the next tick).
          onDone?.(false);
          finish(true);
          return;
        }
        sendToWorker({ type: "trusted-invoke", selector }).then(done);
        return;
      }
      sendToWorker({ type: "trusted-key", action: type, key }).then((result) => {
        keyInFlight = false;
        if (!result.ok) {
          if (failedKey(type, key, result.reason)) return;
        } else {
          noteKeyPath(true);
        }
        pumpKeys();
      });
    };

    const sendMoveKey = (type, key) => {
      keyQueue.push({ type, key });
      pumpKeys();
    };
    // Input events do not reach a background window, so button actions are
    // invoked in the page through the debugger instead. The selector is
    // resolved when the message is sent, not when it is queued.
    const activate = (target, onDone) => {
      if (!target) {
        onDone?.(false);
        return;
      }
      const id = `roa-${shortId()}`;
      target.setAttribute("data-roa-invoke", id);
      keyQueue.push({
        type: "invoke",
        selector: `[data-roa-invoke="${id}"]`,
        target,
        onDone,
      });
      pumpKeys();
    };

    // Gameplay clicks go through the same debugger path as the keys. The
    // element is resolved when the click is sent, not when it is queued, so a
    // card that redraws keeps its current position.
    const clickQueue = [];
    let clickInFlight = false;
    let clickPathState = null;
    const canReplayClicks = canReplayKeys;
    const noteClickPath = (ok, reason = "") => {
      if (clickPathState === ok) return;
      clickPathState = ok;
      logEvent(
        "info",
        ok
          ? "Click-to-move is sent as trusted input."
          : `Trusted mouse replay unavailable: click-based auto-move is not clicking.${
              reason ? ` (${reason})` : ""
            }`,
        { toast: false },
      );
    };
    const clickPoint = (target, dx, dy) => {
      if (!target?.isConnected) return null;
      const box = target.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const x = box.left + box.width / 2 + dx;
      const y = box.top + box.height / 2 + dy;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return null;
      }
      return { x, y };
    };
    const pumpClicks = () => {
      if (clickInFlight || !clickQueue.length) return;
      if (!canReplayClicks) {
        clickQueue.length = 0;
        noteClickPath(false, "no debugger messaging");
        return;
      }
      const { target, dx, dy } = clickQueue.shift();
      const point = clickPoint(target, dx, dy);
      if (!point) {
        pumpClicks();
        return;
      }
      clickInFlight = true;
      sendToWorker({ type: "trusted-click", x: point.x, y: point.y }).then(
        (result) => {
          clickInFlight = false;
          noteClickPath(result.ok, result.reason);
          pumpClicks();
        },
      );
    };
    const trustedClick = (target, dx = 0, dy = 0) => {
      clickQueue.push({ target, dx, dy });
      pumpClicks();
    };
    const releaseLootKeys = () => {
      for (const key of moveState.lootKeys) {
        sendMoveKey("keyup", key);
      }
      moveState.lootKeys.clear();
    };
    const setLootKeys = (wanted) => {
      for (const key of moveState.lootKeys) {
        if (!wanted.has(key)) sendMoveKey("keyup", key);
      }
      for (const key of wanted) {
        if (!moveState.lootKeys.has(key)) sendMoveKey("keydown", key);
      }
      moveState.lootKeys = wanted;
    };
    const lootKeysFor = (loot) => {
      const keys = new Set();
      const dx = loot.x - loot.player.x;
      const dy = loot.y - loot.player.y;
      if (dx > 1.2) keys.add("d");
      else if (dx < -1.2) keys.add("a");
      if (dy > 1.2) keys.add("s");
      else if (dy < -1.2) keys.add("w");
      return keys;
    };

    const movementPaused = () => {
      if (pickerIsOpen() || $("#story:not(.hidden)") || gameDialogOpen()) {
        return true;
      }
      // A character sheet, options window, pause menu or any other game
      // overlay means the player is busy (for example choosing an upgrade).
      if ($(".overlay:not(.hidden)")) return true;
      if (promptPending || promptShown() || dialogOpen()) return true;
      if (panelOpen()) return true;
      if (!runActive && opts.move.onlyInRun) return true;
      if (opts.move.yieldToManual && manualControl()) return true;
      if (isTypingTarget(document.activeElement)) return true;
      return false;
    };

    const tickMove = () => {
      if (!enabled) {
        releaseLootKeys();
        return;
      }
      const wantsLoot =
        opts.move.collectChests ||
        opts.move.collectMagnets ||
        opts.move.collectItems;
      if (!autoMove && !wantsLoot) {
        releaseLootKeys();
        return;
      }
      const t = nowMs();
      // Keys stay held between path steps. Release them as soon as a menu
      // opens, and refresh them so focus changes do not drop movement.
      if (moveState.lootKeys.size) {
        if (movementPaused()) {
          releaseLootKeys();
          moveState.progress = null;
          moveState.lootProgress = null;
          return;
        }
        if (t - moveState.lootKeyAt > 600) {
          for (const key of moveState.lootKeys) sendMoveKey("keydown", key);
          moveState.lootKeyAt = t;
        }
      }
      if (movementPaused()) {
        releaseLootKeys();
        moveState.progress = null;
        moveState.lootProgress = null;
        return;
      }
      const canvas = $("#stage canvas.ro-cursor");
      if (!canvas) {
        releaseLootKeys();
        return;
      }
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) {
        releaseLootKeys();
        return;
      }
      const coords = mapCoords();

      // Ground loot is looked for a few times a second. The last result is
      // reused in between so the hero keeps walking between scans.
      let loot = null;
      if (wantsLoot) {
        if (t >= moveState.lootScanAt) {
          loot = minimapLoot();
          moveState.lootScanAt = t + 250;
          moveState.lootTarget = loot;
        } else {
          loot = moveState.lootTarget;
        }
      } else {
        moveState.lootTarget = null;
      }
      if (loot && t < moveState.lootIgnoreUntil) loot = null;
      noteLootTarget(loot);
      if (loot) {
        if (!moveState.lootActive) {
          moveState.lootActive = true;
          // Remember where the hero left the path, so it can go back there.
          moveState.returnTo = coords ? { ...coords } : null;
          moveState.lootProgress = null;
          moveState.progress = null;
        }
        if (checkLootStuck(coords, loot, t)) {
          moveState.lootIgnoreUntil = t + 5000;
          moveState.lootTarget = null;
          moveState.lootProgress = null;
          moveState.progress = null;
          logEvent("move", "Loot unreachable: going back", { toast: false });
        } else {
          setLootKeys(lootKeysFor(loot));
          return;
        }
      }

      if (moveState.lootActive) {
        if (coords && moveState.returnTo) {
          if (pointsApart(coords, moveState.returnTo) > MOVE_ARRIVE) {
            if (!checkStuck(coords, moveState.returnTo, t)) {
              steerToward(coords, moveState.returnTo, box, t);
            }
            return;
          }
        }
        moveState.lootActive = false;
        moveState.lootTarget = null;
        moveState.lootProgress = null;
        moveState.returnTo = null;
        moveState.progress = null;
        moveState.nextAt = 0;
        logEvent("move", autoMove ? "Back on the path" : "Back at the loot detour point", {
          toast: false,
        });
      }

      if (!autoMove) {
        releaseLootKeys();
        return;
      }

      // No minimap coordinates: keep the old screen-relative movement.
      if (!coords) {
        if (t < moveState.nextAt) return;
        moveState.nextAt = t + opts.move.interval;
        const radius = Math.min(box.width, box.height) * (opts.move.step / 75);
        const [dx, dy] = nextMoveOffset(opts.move.pattern, radius);
        if (opts.move.wasd || !canUseMouse()) {
          setLootKeys(screenKeysFor(dx, dy, radius));
        } else {
          releaseLootKeys();
          clickMoveOffset(dx, dy);
        }
        return;
      }

      if (!moveState.center) moveState.center = { ...coords };
      if (!moveState.target) {
        if (t < moveState.nextAt) {
          releaseLootKeys();
          return;
        }
        moveState.target = nextWaypoint();
        moveState.legAt = t;
        moveState.progress = null;
      }
      if (!moveState.target) return;
      if (pointsApart(coords, moveState.target) <= MOVE_ARRIVE) {
        reachedTarget(t);
        return;
      }
      if (checkStuck(coords, moveState.target, t)) return;
      steerToward(coords, moveState.target, box, t);
    };

    // Real input on the map pauses auto-move, so it never fights the player.
    const bindManualInput = () => {
      const onStage = (target) => {
        const stage = $("#stage");
        return !!stage && target instanceof Node && stage.contains(target);
      };
      window.addEventListener(
        "pointerdown",
        (event) => {
          if (!event.isTrusted || !onStage(event.target)) return;
          moveState.held = true;
          moveState.heldAt = nowMs();
          moveState.manualUntil = nowMs() + MANUAL_PAUSE_MS;
        },
        true,
      );
      const release = (event) => {
        if (!event.isTrusted || !moveState.held) return;
        moveState.held = false;
        moveState.manualUntil = nowMs() + MANUAL_PAUSE_MS;
      };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
      window.addEventListener(
        "pointermove",
        (event) => {
          if (!event.isTrusted || !moveState.held) return;
          if (event.buttons === 0) release(event);
          else moveState.heldAt = nowMs();
        },
        true,
      );
      window.addEventListener("blur", () => {
        moveState.held = false;
        releaseLootKeys();
      });
      window.addEventListener(
        "keydown",
        (event) => {
          if (!event.isTrusted || !MOVE_KEYS.has(event.key)) return;
          // A press this add-on just replayed is not the player taking over.
          if (nowMs() - moveState.selfKeyAt < SELF_KEY_MS) return;
          if (isTypingTarget(event.target)) return;
          moveState.manualUntil = nowMs() + MANUAL_PAUSE_MS;
        },
        true,
      );
    };

    // ---------------------------------------------------------- loot rolls --
    let lastPickupClick = 0;
    // Longest matching name wins; "*" matches everything and is the least
    // specific, which makes it a per-quality default.
    const pickupRuleFor = (name, quality) => {
      const wanted = lower(name);
      let rule = null;
      let ruleWeight = -1;
      for (const entry of pickupData.rules) {
        if (!entry.name) continue;
        const wild = entry.name === "*";
        if (!wild && !wanted.includes(lower(entry.name))) continue;
        if (quality < (entry.quality ?? -1)) continue;
        const weight = wild ? 0 : entry.name.length;
        if (
          !rule ||
          weight > ruleWeight ||
          (weight === ruleWeight && (entry.quality ?? -1) > (rule.quality ?? -1))
        ) {
          rule = entry;
          ruleWeight = weight;
        }
      }
      return rule;
    };
    const tickPickup = () => {
      if (!enabled || !pickupEnabled) return;
      const reveal = $("#drop-reveal");
      if (!reveal || reveal.classList.contains("hidden")) return;
      if (!reveal.querySelector(".dr-roll-btns [data-c]")) return;
      if (performance.now() - lastPickupClick < 400) return;
      const name = text(reveal, ".dr-name");
      const quality = rarityOf(reveal);
      const rule = pickupRuleFor(name, quality);
      const action = rule?.action ?? pickupData.other;
      if (!ACTION_VALUES.includes(action)) return;
      const button = reveal.querySelector(`.dr-roll-btns [data-c="${action}"]`);
      if (!button || button.disabled) return;
      lastPickupClick = performance.now();
      runStats[action] += 1;
      const label = action[0].toUpperCase() + action.slice(1);
      logEvent(
        "loot",
        `${label}: ${name || "item"}${rule ? ` (rule "${rule.name}")` : ""}`,
        { toast: action !== "pass" },
      );
      activate(button);
    };

    // =====================================================================
    // 7. Interface
    // =====================================================================
    const PANEL_ID = "ro-auto-panel";
    const PROMPT_ID = "ro-auto-prompt";
    const HINT_ID = "ro-auto-hint";
    const TOASTS_ID = "ro-auto-toasts";
    const DIALOG_ID = "ro-auto-dialog";

    // Typing in our own fields must not trigger the game's hotkeys.
    const shieldKeys = (el) => {
      for (const type of ["keydown", "keyup", "keypress"]) {
        el.addEventListener(type, (event) => event.stopPropagation());
      }
    };

    // -------------------------------------------------------------- hints --
    let hintMode = "";
    const showHint = (message, mode) => {
      if (!document.body) return;
      let hint = $(`#${HINT_ID}`);
      if (!hint) {
        hint = document.createElement("div");
        hint.id = HINT_ID;
        hint.setAttribute("role", "status");
        document.body.append(hint);
      }
      if (hint.textContent !== message) hint.textContent = message;
      hint.dataset.mode = mode;
      hintMode = mode;
    };
    const hideHint = () => {
      if (!hintMode) return;
      hintMode = "";
      $(`#${HINT_ID}`)?.remove();
    };

    // ------------------------------------------------------------- toasts --
    const showToast = (message, kind = "info") => {
      if (!document.body) return;
      let box = $(`#${TOASTS_ID}`);
      if (!box) {
        box = document.createElement("div");
        box.id = TOASTS_ID;
        document.body.append(box);
      }
      const item = document.createElement("div");
      item.className = `roa-toast roa-toast-${kind}`;
      item.textContent = message;
      box.append(item);
      while (box.children.length > 4) box.firstElementChild.remove();
      setTimeout(() => {
        item.remove();
        if (!box.children.length) box.remove();
      }, 3200);
    };
    let panelRenderQueued = false;
    const logEvent = (kind, message, options = {}) => {
      activity.push({ at: nowMs(), kind, message });
      if (activity.length > MAX_ACTIVITY) {
        activity.splice(0, activity.length - MAX_ACTIVITY);
      }
      saveActivity();
      if (options.toast !== false && (opts.toasts || options.force)) {
        showToast(message, kind);
      }
      if (panelOpen() && panelView === "log" && !panelRenderQueued) {
        panelRenderQueued = true;
        setTimeout(() => {
          panelRenderQueued = false;
          if (panelOpen() && panelView === "log") renderPanel();
        }, 150);
      }
    };
    const notify = (message, kind = "info") => showToast(message, kind);

    // ------------------------------------------------------------ dialogs --
    // In-page replacements for alert / confirm / prompt. The browser's own
    // dialogs freeze the page, which is the last thing a running game needs.
    let dialogActive = false;
    const dialogQueue = [];
    const dialogOpen = () => dialogActive;
    const pumpDialog = () => {
      if (dialogActive || !dialogQueue.length) return;
      const { spec, resolve } = dialogQueue.shift();
      if (!document.body) {
        resolve(spec.input != null ? null : false);
        pumpDialog();
        return;
      }
      dialogActive = true;
      const hasInput = spec.input != null;
      const overlay = document.createElement("div");
      overlay.id = DIALOG_ID;
      overlay.innerHTML = `<div class="roa-dialog" role="dialog" aria-modal="true">
        <b class="roa-dialog-title">${esc(spec.title)}</b>
        ${spec.message ? `<div class="roa-dialog-msg">${esc(spec.message)}</div>` : ""}
        ${
          !hasInput
            ? ""
            : spec.multiline
              ? `<textarea class="roa-dialog-input" rows="9" spellcheck="false"></textarea>`
              : `<input type="text" class="roa-dialog-input" maxlength="${spec.maxLength ?? 60}">`
        }
        <div class="roa-dialog-btns">
          ${spec.cancel === false ? "" : `<button type="button" class="roa-btn" data-dialog="cancel">${esc(spec.cancelLabel ?? "Cancel")}</button>`}
          <button type="button" class="roa-btn ${spec.danger ? "roa-danger" : "roa-primary"}" data-dialog="ok">${esc(spec.okLabel ?? "OK")}</button>
        </div>
      </div>`;
      const input = overlay.querySelector(".roa-dialog-input");
      if (input) input.value = String(spec.input ?? "");
      const finish = (accepted) => {
        overlay.remove();
        dialogActive = false;
        if (hasInput) resolve(accepted ? input.value : null);
        else resolve(!!accepted);
        pumpDialog();
      };
      overlay.addEventListener("click", (event) => {
        const which = event.target.closest?.("[data-dialog]")?.dataset.dialog;
        if (which === "ok") finish(true);
        else if (which === "cancel") finish(false);
        else if (event.target === overlay) finish(spec.cancel === false);
      });
      overlay.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          finish(spec.cancel === false);
        } else if (event.key === "Enter") {
          const onField = event.target === input;
          if (onField && spec.multiline && !event.ctrlKey && !event.metaKey) return;
          if (onField || event.target === overlay) {
            event.preventDefault();
            finish(true);
          }
        }
      });
      for (const type of ["keyup", "keypress"]) {
        overlay.addEventListener(type, (event) => event.stopPropagation());
      }
      document.body.append(overlay);
      const focusTarget = input || overlay.querySelector('[data-dialog="ok"]');
      try {
        focusTarget.focus();
        if (input && !spec.multiline) input.select();
      } catch {}
    };
    const openDialog = (spec) =>
      new Promise((resolve) => {
        dialogQueue.push({ spec, resolve });
        pumpDialog();
      });
    const uiAlert = (title, message) =>
      openDialog({ title, message, cancel: false });
    const uiConfirm = (title, message, extra = {}) =>
      openDialog({ title, message, ...extra });
    const uiPrompt = (title, value, extra = {}) =>
      openDialog({ title, input: value ?? "", ...extra });

    // -------------------------------------------------- settings triggers --
    const TITLE_GEAR_CLASS = "roa-title-gear";
    const OPTIONS_BTN_CLASS = "roa-options-open";
    const modeLabel = () =>
      !enabled ? "Auto OFF" : opts.suggestOnly && priorityEnabled ? "Suggest" : "Auto";
    const triggerTitle = () => {
      const parts = [
        `RO Auto ${enabled ? "on" : "off"}`,
        `auto-pick ${priorityEnabled ? (opts.suggestOnly ? "suggests" : "on") : "off"}`,
        `auto-move ${autoMove ? "on" : "off"} (F8)`,
        `loot rolls ${pickupEnabled ? "on" : "off"}`,
      ];
      if (activeBuild && runActive) parts.push(`build: ${activeBuild.name}`);
      return `${parts.join(" · ")}\nClick or F9 for settings.`;
    };
    const syncCustomizeTriggers = () => {
      const gear = $(`#minimap .${TITLE_GEAR_CLASS}`);
      if (gear) {
        gear.classList.toggle("off", !enabled);
        gear.title = triggerTitle();
        gear.setAttribute("aria-label", `RO Auto settings (${modeLabel()})`);
      }
      const button = $(`#options .${OPTIONS_BTN_CLASS}`);
      if (button) {
        button.classList.toggle("off", !enabled);
        button.title = triggerTitle();
      }
    };
    const onTriggerClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    };
    const ensureMapGear = () => {
      const title = $("#minimap .ro-title");
      const existing = title?.querySelector(`.${TITLE_GEAR_CLASS}`) ?? null;
      if (!opts.titleGear || !title) {
        existing?.remove();
        return;
      }
      if (existing) return;
      const gear = document.createElement("button");
      gear.type = "button";
      gear.className = TITLE_GEAR_CLASS;
      gear.textContent = "⚙";
      gear.title = triggerTitle();
      gear.setAttribute("aria-label", "RO Auto settings");
      gear.addEventListener("pointerdown", (event) => event.stopPropagation());
      gear.addEventListener("click", onTriggerClick);
      title.append(gear);
    };
    const ensureOptionsButton = () => {
      const body = $("#options .ro-window > .ro-body");
      const existing = body?.querySelector(`.${OPTIONS_BTN_CLASS}`) ?? null;
      if (!opts.bodyButton || !body) {
        existing?.remove();
        return;
      }
      if (existing) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ro-btn ${OPTIONS_BTN_CLASS}`;
      button.textContent = "⚙ Customize";
      button.title = triggerTitle();
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
      button.addEventListener("click", onTriggerClick);
      body.append(button);
    };
    const ensureCustomizeTriggers = () => {
      ensureMapGear();
      ensureOptionsButton();
      syncCustomizeTriggers();
    };

    // --------------------------------------------------- run start prompt --
    // Card picking waits while the prompt is up (or about to be), so the
    // first pick already uses the build you chose.
    const PROMPT_MS = 8000;
    const PROMPT_MAX_MS = 20000; // even with the pointer resting on it
    let promptPending = false;
    let promptTimer = 0;
    let promptShownAt = 0;
    const promptShown = () => !!$(`#${PROMPT_ID}`);
    const hidePrompt = () => {
      clearTimeout(promptTimer);
      promptTimer = 0;
      promptPending = false;
      $(`#${PROMPT_ID}`)?.remove();
    };
    const armPromptTimer = (ms) => {
      clearTimeout(promptTimer);
      const left = promptShownAt + PROMPT_MAX_MS - nowMs();
      promptTimer = setTimeout(hidePrompt, Math.max(0, Math.min(ms, left)));
    };
    const renderPrompt = (panel) => {
      const job = cls || activeBuildClass || settingsClass || "swordsman";
      const bucket = classBuilds(job);
      const current = activeBuildClass === job ? activeBuild : null;
      panel.innerHTML = `
        <div class="roa-prompt-head">
          <b>Choose build</b>
          <button type="button" class="roa-icon-btn" data-prompt="close" title="Keep the current build">×</button>
        </div>
        <div class="roa-prompt-class">
          <select data-prompt="job" title="Class for this run">
            ${Object.keys(SKILLS)
              .map(
                (id) =>
                  `<option value="${id}" ${id === job ? "selected" : ""}>${esc(jobLabel(id))}</option>`,
              )
              .join("")}
          </select>
          <small>${cls ? "detected" : "not detected yet"} · auto-picks for this run</small>
        </div>
        <div class="roa-prompt-builds">
          ${
            bucket.builds.length
              ? bucket.builds
                  .map(
                    (build) =>
                      `<button type="button" class="roa-btn ${build.id === (current?.id ?? bucket.active) ? "sel" : ""}" data-prompt="build" data-id="${esc(build.id)}">${esc(build.name)}</button>`,
                  )
                  .join("")
              : `<small>No builds for this class.</small>`
          }
        </div>
        <button type="button" class="roa-btn" data-prompt="edit">Customize builds…</button>
        <small>Using ${esc(current?.name ?? "no build")} if nothing is picked.</small>
        <div class="roa-prompt-bar"><span></span></div>`;
    };
    const showPrompt = () => {
      promptPending = false;
      if (!enabled || !priorityEnabled || !runActive) return;
      if (promptShown() || !document.body) return;
      const panel = document.createElement("div");
      panel.id = PROMPT_ID;
      renderPrompt(panel);
      panel.addEventListener("click", (event) => {
        const el = event.target.closest?.("[data-prompt]");
        if (!el) return;
        const job = cls || activeBuildClass || settingsClass || "swordsman";
        switch (el.dataset.prompt) {
          case "close":
            hidePrompt();
            break;
          case "build": {
            const build = classBuilds(job).builds.find(
              (entry) => entry.id === el.dataset.id,
            );
            if (build) {
              promptChoiceName = build.name;
              activeBuild = build;
              activeBuildClass = job;
              setActiveBuild(job, build);
              syncCustomizeTriggers();
            }
            hidePrompt();
            break;
          }
          case "edit":
            openPanel("builds", job);
            break;
          default:
        }
      });
      panel.addEventListener("change", (event) => {
        const el = event.target.closest?.('[data-prompt="job"]');
        if (!el || !SKILLS[el.value]) return;
        // The player knows best which class this is.
        cls = el.value;
        activeBuildClass = null;
        switchActiveBuildForClass(cls);
        renderPrompt(panel);
        armPromptTimer(PROMPT_MS);
      });
      // Hovering gives more time to read, up to a limit: cards are not
      // picked while the prompt is up.
      panel.addEventListener("pointerenter", () => {
        armPromptTimer(PROMPT_MAX_MS);
        panel.classList.add("paused");
      });
      panel.addEventListener("pointerleave", () => {
        panel.classList.remove("paused");
        armPromptTimer(3000);
      });
      shieldKeys(panel);
      document.body.append(panel);
      promptShownAt = nowMs();
      armPromptTimer(PROMPT_MS);
    };
    // Give the HUD a moment to show the class before asking.
    const queuePrompt = () => {
      if (!enabled || !priorityEnabled || !opts.askBuild) return;
      promptPending = true;
      const startedAt = nowMs();
      const attempt = () => {
        if (!promptPending) return;
        if (!runActive) {
          promptPending = false;
          return;
        }
        syncClass();
        if (cls || nowMs() - startedAt > 1200) showPrompt();
        else setTimeout(guard("prompt", attempt), 150);
      };
      attempt();
    };
    const uiBlocksPicking = () =>
      promptPending || promptShown() || panelOpen() || dialogOpen();

    // =====================================================================
    // 8. Settings panel
    // =====================================================================
    const TABS = [
      ["general", "General"],
      ["move", "Movement"],
      ["builds", "Builds"],
      ["loot", "Loot"],
      ["cards", "Cards"],
      ["log", "Activity"],
      ["data", "Backup"],
    ];
    let panelView = "general";
    const cardFilter = { query: "", slot: "", stat: "" };
    let renderedView = "";
    let editingBuildId = null;
    let dragState = null;
    let undoSnapshot = null;

    const panelEl = () => $(`#${PANEL_ID}`);
    const panelOpen = () => !!panelEl();
    const editingBuild = () =>
      classBuilds(settingsClass).builds.find(
        (build) => build.id === editingBuildId,
      ) ?? null;

    // ------------------------------------------------------------ setters --
    const refreshUi = () => {
      ensureCustomizeTriggers();
      if (panelOpen()) renderPanel();
    };
    const setEnabled = (value) => {
      enabled = !!value;
      saveNow(KEYS.enabled, enabled ? "1" : "0");
      if (!enabled) {
        hidePrompt();
        clearSuggestion();
        hideHint();
      }
      refreshUi();
    };
    const setAutoMove = (value) => {
      autoMove = !!value;
      saveNow(KEYS.move, autoMove ? "1" : "0");
      moveState.nextAt = 0;
      moveState.target = null;
      moveState.progress = null;
      if (!autoMove) {
        releaseLootKeys();
      } else {
        // Start the next pattern from wherever the hero is standing.
        moveState.center = null;
      }
      refreshUi();
    };
    const setPriorityEnabled = (value) => {
      priorityEnabled = !!value;
      saveNow(KEYS.priority, priorityEnabled ? "1" : "0");
      if (!priorityEnabled) {
        hidePrompt();
        clearSuggestion();
        hideHint();
      }
      refreshUi();
    };
    const setPickupEnabled = (value) => {
      pickupEnabled = !!value;
      saveNow(KEYS.pickupOn, pickupEnabled ? "1" : "0");
      refreshUi();
    };
    const applyKeepActive = async () => {
      if (!opts.keepActive) return;
      const options = $("#options");
      const wasOpen = !!options && !options.classList.contains("hidden");
      const OPENERS = ["#lobby-options", "#btn-pause-options", "#btn-options"];
      // The game builds the Options window on demand since 0.6, so an unopened
      // window has no tabs to click. Open it through one of the game's own
      // buttons first; at start-up they are wired a few seconds in, so keep
      // clicking until the tabs appear. (Their onclick belongs to the page
      // world and cannot be inspected from a content script.)
      let opened = false;
      if (!wasOpen && !$('#opt-tabs [data-opt-tab="game"]')) {
        opened = true;
        const ready = await waitFor(
          () => {
            if ($('#opt-tabs [data-opt-tab="game"]')) return true;
            const opener = OPENERS.map((selector) => $(selector)).find(Boolean);
            opener?.click();
            return $('#opt-tabs [data-opt-tab="game"]') || null;
          },
          30000,
          500,
        );
        if (!ready) {
          noteError("auto-pause", new Error("game options not found"));
          return;
        }
      }
      const tab = await waitFor(
        () => $('#opt-tabs [data-opt-tab="game"]'),
        1500,
        50,
      );
      if (!tab) {
        if (opened) $("#opt-close")?.click();
        noteError("auto-pause", new Error("game options not found"));
        return;
      }
      const previous = $('#opt-tabs .tab-btn.active')?.dataset.optTab;
      if (previous !== "game") tab.click();
      const input = await waitFor(
        () => $('#opt-body input[data-check="autoPause"]'),
        1500,
        50,
      );
      if (!input) {
        if (opened) $("#opt-close")?.click();
        noteError("auto-pause", new Error("auto-pause setting not found"));
        return;
      }
      if (input.checked) {
        input.click();
        logEvent("info", "Game auto-pause turned off.", { toast: false });
      }
      if (opened) $("#opt-close")?.click();
      else if (!wasOpen && previous && previous !== "game") {
        $(`#opt-tabs [data-opt-tab="${previous}"]`)?.click();
      }
    };
    const setOption = (key, value) => {
      opts[key] = !!value;
      saveOptions();
      if (key === "suggestOnly" && !opts.suggestOnly) clearSuggestion();
      if (key === "askBuild" && !opts.askBuild) hidePrompt();
      if (key === "keepActive" && opts.keepActive) {
        applyKeepActive().catch((error) => noteError("auto-pause", error));
      }
      refreshUi();
    };

    // ------------------------------------------------------ option lists --
    const optionName = (entry) =>
      (entry.names?.[0] ?? entry.id) + (entry.learned ? " (detected)" : "");
    const optionSort = (a, b) =>
      optionName(a).localeCompare(optionName(b), undefined, {
        sensitivity: "base",
      });
    const itemDescription = (entry) => {
      if (entry.skillDeity) return "Skill deity";
      return (ITEM_STATS[entry.id] ?? entry.stats ?? [])
        .map((key) => ITEM_STAT_LABELS[key] ?? key)
        .join(" · ");
    };
    const itemOptionName = (entry) => {
      const desc = itemDescription(entry);
      return desc ? `${optionName(entry)} — ${desc}` : optionName(entry);
    };
    const optionsHtml = (list, selected, options = {}) => {
      const label = options.label ?? optionName;
      const title = options.title ?? optionName;
      const known = list.some((entry) => entry.id === selected);
      const blank = options.blank === false ? "" : `<option value="">—</option>`;
      const extra =
        selected && !known
          ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>`
          : "";
      return (
        blank +
        list
          .map(
            (entry) =>
              `<option value="${esc(entry.id)}" ${
                entry.id === selected ? "selected" : ""
              } title="${esc(title(entry))}">${esc(label(entry))}</option>`,
          )
          .join("") +
        extra
      );
    };
    const requiredOptions = (selected) =>
      optionsHtml(
        classSkills(settingsClass)
          .filter((entry) => entry !== AUTO_SKILL)
          .sort(optionSort),
        selected,
      );
    const upgradeSkillOptions = (selected, build, blank) =>
      optionsHtml(availableUpgradeSkills(build).sort(optionSort), selected, {
        blank,
      });
    const itemOptions = (selected, blank) =>
      optionsHtml(
        [...classItems(settingsClass), ...skillDeityEntries(settingsClass)].sort(
          optionSort,
        ),
        selected,
        {
          blank,
          label: itemOptionName,
          title: (entry) => itemDescription(entry) || optionName(entry),
        },
      );
    const statOptions = (keys, selected, labels = STAT_LABELS) => {
      const list = keys.includes(selected) ? keys : [...keys, selected];
      return list
        .map(
          (key) =>
            `<option value="${esc(key)}" ${key === selected ? "selected" : ""}>${esc(
              labels[key] ?? key,
            )}</option>`,
        )
        .join("");
    };
    const mapOptions = (map, selected) => {
      const entries = Object.entries(map);
      if (!entries.some(([value]) => String(value) === String(selected))) {
        entries.push([String(selected), "Custom"]);
      }
      return entries
        .map(
          ([value, label]) =>
            `<option value="${esc(value)}" ${
              String(value) === String(selected) ? "selected" : ""
            }>${esc(label)}</option>`,
        )
        .join("");
    };
    const checkHtml = (attrs, checked, label, hint = "") =>
      `<label class="opt-row opt-check roa-check"><span><b>${label}</b>${
        hint ? `<small>${hint}</small>` : ""
      }</span><input type="checkbox" ${attrs} ${
        checked ? "checked" : ""
      }><i class="opt-switch"></i></label>`;
    const qualityOptions = (selected) =>
      [-1, 0, 1, 2, 3, 4]
        .map(
          (value) =>
            `<option value="${value}" ${
              Number(selected) === value ? "selected" : ""
            }>${value < 0 ? "Any" : esc(QUALITY_NAMES[value])}</option>`,
        )
        .join("");
    const itemRarityOptions = (selected) =>
      [1, 2, 3, 4]
        .map(
          (value) =>
            `<option value="${value}" ${
              Number(selected) === value ? "selected" : ""
            }>${esc(QUALITY_NAMES[value])} and higher</option>`,
        )
        .join("");
    const actionOptions = (selected) =>
      ACTION_VALUES.map(
        (action) =>
          `<option value="${action}" ${action === selected ? "selected" : ""}>${
            action[0].toUpperCase() + action.slice(1)
          }</option>`,
      ).join("");

    // -------------------------------------------------------------- views --
    const stateLabel = () =>
      !enabled ? "OFF" : opts.suggestOnly && priorityEnabled ? "SUGGEST" : "ON";
    const runStatus = () => {
      if (!runActive) return "No run in progress.";
      const job = cls ? jobLabel(cls) : "class not detected yet";
      const build = activeBuild ? `build “${esc(activeBuild.name)}”` : "no build";
      return `In a run · ${esc(job)} · ${build}`;
    };
    const headHtml = () => `
      <div class="ro-title roa-modal-title">
        <span class="roa-heading"><b>RO Auto</b> <small>v${esc(VERSION)}</small></span>
        <span class="roa-state ${enabled ? "" : "off"}">${stateLabel()}</span>
        <button type="button" class="ro-btn small roa-close" data-click="close" title="Close (F9)">×</button>
      </div>`;
    const panelNavHtml = () => {
      const tab = panelView === "build" ? "builds" : panelView;
      const paused = enabled && priorityEnabled && !opts.suggestOnly;
      return `
        <div class="tabs roa-tabs">
          ${TABS.map(
            ([id, label]) =>
              `<button type="button" class="tab-btn ${id === tab ? "active" : ""}" data-click="tab" data-tab="${id}">${label}</button>`,
          ).join("")}
        </div>
        ${paused ? `<div class="opt-note roa-note">Card picking is paused while this panel is open.</div>` : ""}`;
    };

    const generalViewHtml = () => `
      <div class="roa-section">
        <div class="roa-row">
          <button type="button" class="ro-btn roa-power ${enabled ? "" : "primary"}" data-click="power">${enabled ? "Turn addon off" : "Turn addon on"}</button>
          <small class="roa-grow">${runStatus()}</small>
        </div>
        ${checkHtml('data-change="flag" data-flag="priority"', priorityEnabled, "Pick cards for me", "Skill and item cards, by the active build.")}
        ${checkHtml('data-change="opt" data-opt="suggestOnly"', opts.suggestOnly, "Suggest only", "Highlight the best card and leave the click to me.")}
        ${checkHtml('data-change="opt" data-opt="askBuild"', opts.askBuild, "Ask which build to use when a run starts")}
        ${checkHtml('data-change="flag" data-flag="pickup"', pickupEnabled, "Roll on party loot", "Need / Greed / Pass by the rules on the Loot tab.")}
        ${checkHtml('data-change="opt" data-opt="toasts"', opts.toasts, "Show a short note for each action")}
        ${checkHtml('data-change="opt" data-opt="manualSound"', opts.manualSound, "Play a sound when a card needs my choice")}
        ${checkHtml('data-change="opt" data-opt="keepActive"', opts.keepActive, "Disable game auto-pause", "Keep running when you switch tab or app.")}
      </div>
      <div class="roa-section">
        <b>Interface</b>
        ${checkHtml('data-change="opt" data-opt="titleGear"', opts.titleGear, "Gear icon on the map title", "Opens these settings from the minimap.")}
        ${checkHtml('data-change="opt" data-opt="bodyButton"', opts.bodyButton, "Customize button in the Options menu", "Adds a button to the ESC / Options window.")}
      </div>
      <div class="roa-section">
        <small>Auto-move and ground-loot collection are on the Movement tab. Reroll rules are in each build. F8 toggles auto-move · F9 opens this panel.</small>
      </div>`;

    const moveViewHtml = () => `
      <div class="roa-section">
        <b>Auto-move</b>
        ${checkHtml('data-change="flag" data-flag="move"', autoMove, "Keep the hero moving (F8)")}
        ${checkHtml('data-change="move-flag" data-flag="wasd"', opts.move.wasd, "Move with WASD instead of clicking", "Uses the same path and pace with the game's movement keys.")}
        <div class="roa-grid3">
          <label><small>Path</small><select data-change="move" data-move="pattern">${mapOptions(MOVE_PATTERNS, opts.move.pattern)}</select></label>
          <label><small>Step length</small><input type="number" data-change="move" data-move="step" value="${opts.move.step}" min="1" max="500" step="1"></label>
          <label><small>Pace</small><select data-change="move" data-move="interval">${mapOptions(MOVE_PACES, opts.move.interval)}</select></label>
        </div>
        <small>Steps are measured in the map coordinates shown on the minimap title.</small>
        ${checkHtml('data-change="move-flag" data-flag="yieldToManual"', opts.move.yieldToManual, "Pause for a few seconds when I move the hero myself")}
        ${checkHtml('data-change="move-flag" data-flag="onlyInRun"', opts.move.onlyInRun, "Only during a run", "Stand still in town and in menus.")}
      </div>
      <div class="roa-section">
        <b>Ground loot</b>
        <small>Reads the chest, magnet and dropped-item icons on the minimap and walks to them. It still walks when auto-move is off.</small>
        ${checkHtml('data-change="move-flag" data-flag="collectChests"', opts.move.collectChests, "Open treasure chests", "Only when you can afford the opening cost.")}
        ${checkHtml('data-change="move-flag" data-flag="collectMagnets"', opts.move.collectMagnets, "Pick up magnets", "Vacuums every gem on the map.")}
        ${checkHtml('data-change="move-flag" data-flag="collectItems"', opts.move.collectItems, "Pick up dropped items", "Loot and cards shown on the minimap.")}
        <div class="roa-row">
          <span>Item rarity and higher</span>
          <select data-change="move" data-move="itemRarity" title="Only walk to items of this rarity or better">${itemRarityOptions(opts.move.itemRarity)}</select>
        </div>
      </div>
      <div class="roa-section">
        <small>Movement waits while the level-up/chest picker, a game window, or this settings panel/dialog is open.</small>
      </div>`;

    const buildsViewHtml = () => {
      const bucket = classBuilds(settingsClass);
      const builds = bucket.builds;
      return `
        <div class="roa-section">
          <div class="roa-row">
            <span>Job class</span>
            <select data-change="job">
              ${Object.keys(SKILLS)
                .map(
                  (job) =>
                    `<option value="${job}" ${job === settingsClass ? "selected" : ""}>${esc(jobLabel(job))}</option>`,
                )
                .join("")}
            </select>
            ${cls && runActive ? `<small>Playing: ${esc(jobLabel(cls))}</small>` : ""}
          </div>
          <div class="roa-builds">
            ${
              builds.length
                ? builds
                    .map((build, index) => {
                      const active = build.id === bucket.active;
                      return `<div class="roa-build-row ${active ? "sel" : ""}">
                        <button type="button" class="ro-btn small roa-use ${active ? "sel" : ""}" data-click="build-use" data-id="${esc(build.id)}" title="${active ? "Active build" : "Use this build"}" aria-pressed="${active}">${active ? "★" : "☆"}</button>
                        <button type="button" class="ro-btn roa-build-open" data-click="build-open" data-id="${esc(build.id)}" title="Edit">${esc(build.name)}</button>
                        <button type="button" class="ro-btn small" data-click="build-move" data-id="${esc(build.id)}" data-dir="-1" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
                        <button type="button" class="ro-btn small" data-click="build-move" data-id="${esc(build.id)}" data-dir="1" title="Move down" ${index === builds.length - 1 ? "disabled" : ""}>↓</button>
                        <button type="button" class="ro-btn small" data-click="build-copy" data-id="${esc(build.id)}" title="Duplicate">⧉</button>
                        <button type="button" class="ro-btn small" data-click="build-remove" data-id="${esc(build.id)}" title="Remove build">×</button>
                      </div>`;
                    })
                    .join("")
                : `<small>No builds. Add one below.</small>`
            }
          </div>
          <div class="roa-row">
            <button type="button" class="ro-btn" data-click="build-add">+ Add build</button>
            <button type="button" class="ro-btn" data-click="build-paste">Paste a build…</button>
            <button type="button" class="ro-btn" data-click="build-defaults">Restore default builds</button>
          </div>
          <small>★ marks the build used for ${esc(jobLabel(settingsClass))} runs. Click a name to edit it.</small>
        </div>`;
    };

    const upgradeRowHtml = (row, index, kind, focused, groupIndex, build) => {
      const names =
        kind === "skill"
          ? upgradeSkillOptions(row.name, build, false)
          : itemOptions(row.name, false);
      const stats =
        kind === "skill"
          ? statOptions(availableSkillAspects(skillById.get(row.name)), row.upgrade)
          : statOptions(availableItemStats(row.name), row.upgrade, ITEM_STAT_LABELS);
      const used = summaryUsed(row) ?? (runPickValues.get(row.id) ?? 0);
      const limitTitle = `Cap: upgrades that would pass this total are skipped; 0 = unlimited${
        used ? `. This run so far: ${Math.round(used * 100) / 100}` : ""
      }`;
      return `<div class="roa-upgrade" data-kind="${kind}" data-index="${index}" data-group="${groupIndex}">
        <span class="roa-drag" draggable="true" title="Drag to reorder">⋮⋮</span>
        <select data-change="row-name" aria-label="Name">${names}</select>
        <select data-change="row-stat" aria-label="Upgrade">${stats}</select>
        <input type="number" data-input="row-limit" value="${row.limit}" min="0" step="1" title="${esc(limitTitle)}" aria-label="Limit">
        <button type="button" class="ro-btn small roa-star ${focused ? "sel" : ""}" data-click="row-focus" title="Focus this ${kind} with a Focus perk" aria-pressed="${!!focused}">★</button>
        <button type="button" class="ro-btn small" data-click="row-remove" title="Remove">×</button>
      </div>`;
    };
    const UPGRADE_HEAD = `<div class="roa-upgrade roa-upgrade-head">
      <span></span><small>Name</small><small>Upgrade</small><small>Limit</small><small title="Focus perk">★</small><span></span>
    </div>`;
    const addRowHtml = (kind, groupIndex, build) => `
      <div class="roa-add-row" data-kind="${kind}" data-group="${groupIndex}">
        <select class="roa-add-name" data-change="add-name" aria-label="Name">${
          kind === "skill" ? upgradeSkillOptions("", build, true) : itemOptions("", true)
        }</select>
        <select class="roa-add-upgrade" aria-label="Upgrade">${statOptions(["any"], "any")}</select>
        <input type="number" class="roa-add-limit" value="0" min="0" step="1" title="Cap: upgrades that would pass this total are skipped; 0 = unlimited" aria-label="Limit">
        <button type="button" class="ro-btn" data-click="row-add">Add</button>
      </div>`;

    const buildViewHtml = (build) => {
      const bucket = classBuilds(settingsClass);
      const active = build.id === bucket.active;
      const groups = build.itemGroups ?? [];
      const focusedSkill = (id) =>
        id === AUTO_SKILL.id
          ? build.autoMode === "focus"
          : build.focusSkills.includes(id);
      return `
        <div class="roa-section roa-build-head">
          <div class="roa-row">
            <button type="button" class="ro-btn small" data-click="back" title="Back to the build list">←</button>
            <input type="text" class="roa-grow roa-build-name" data-input="build-name" data-change="build-name-done" value="${esc(build.name)}" maxlength="60" aria-label="Build name">
            <small>${esc(jobLabel(settingsClass))}</small>
          </div>
          <div class="roa-row">
            ${
              active
                ? `<span class="roa-chip">★ Active build</span>`
                : `<button type="button" class="ro-btn primary" data-click="build-use" data-id="${esc(build.id)}">Use this build</button>`
            }
            <button type="button" class="ro-btn" data-click="build-copy" data-id="${esc(build.id)}">Duplicate</button>
            <button type="button" class="ro-btn" data-click="build-share" data-id="${esc(build.id)}" title="Copy this build as text, to share or keep">Copy as text</button>
          </div>
        </div>
        <div class="roa-section">
          <b>Required skills</b>
          <div class="roa-required">
            ${[0, 1, 2, 3]
              .map(
                (index) => `<div class="roa-required-row">
                  <button type="button" class="ro-btn small" data-click="req-move" data-index="${index}" data-dir="-1" title="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
                  <button type="button" class="ro-btn small" data-click="req-move" data-index="${index}" data-dir="1" title="Move down" ${index === 3 ? "disabled" : ""}>↓</button>
                  <select data-change="req" data-index="${index}" aria-label="Required skill ${index + 1}">${requiredOptions(build.required[index])}</select>
                  <button type="button" class="ro-btn small roa-star ${
                    build.required[index] && focusedSkill(build.required[index]) ? "sel" : ""
                  }" data-click="req-focus" data-index="${index}" ${
                    build.required[index] ? "" : "disabled"
                  } title="Focus this skill with a Focus perk">★</button>
                </div>`,
              )
              .join("")}
            <div class="roa-required-row roa-auto-row">
              <span class="roa-grow"><b>Auto attack</b></span>
              <select data-change="auto-mode" aria-label="Auto attack">
                ${AUTO_MODES.map(
                  (mode) =>
                    `<option value="${mode}" ${build.autoMode === mode ? "selected" : ""}>${
                      mode[0].toUpperCase() + mode.slice(1)
                    }</option>`,
                ).join("")}
              </select>
            </div>
          </div>
          ${checkHtml('data-change="build-flag" data-flag="newOverUpgrades" data-invert="1"', !build.newOverUpgrades, "Prioritize upgrades over new skills")}
          ${checkHtml('data-change="build-flag" data-flag="manualFallback"', build.manualFallback, "Let me choose manually when no prioritized option is available (after rerolls)")}
        </div>
        <div class="roa-section">
          <b>Rerolls</b>
          <label class="roa-row"><span>Rerolls per offer, at most</span><input type="number" class="roa-short" data-input="max-rerolls" value="${build.maxRerolls}" min="0" max="10" step="1"></label>
          ${checkHtml('data-change="build-flag" data-flag="rerollNoSkill"', build.rerollNoSkill, "Reroll while a required skill is still missing and none is offered")}
          ${checkHtml('data-change="build-flag" data-flag="rerollNoUpgrade"', build.rerollNoUpgrade, "Reroll when nothing for a required skill is offered", "Neither an upgrade nor a required skill that is still missing.")}
          ${checkHtml('data-change="build-flag" data-flag="itemRerollNoPriority"', build.itemRerollNoPriority, "Reroll if there is no item from the priority list")}
          ${checkHtml('data-change="build-flag" data-flag="itemRerollDeityWrong"', build.itemRerollDeityWrong, "Reroll deity if it is not the one you want from the priority list")}
          ${checkHtml('data-change="build-flag" data-flag="fillSlotsFirst"', build.fillSlotsFirst, "With no rerolls left, fill empty item slots from priority before upgrading")}
          ${
            groups[0]?.mandatory
              ? checkHtml('data-change="build-flag" data-flag="mandatoryCardReroll"', build.mandatoryCardReroll, "When the mandatory group is missing: use card rerolls for suitable items") +
                checkHtml('data-change="build-flag" data-flag="mandatoryFullReroll"', build.mandatoryFullReroll, "Then use full rerolls after card rerolls")
              : ""
          }
          <small>Counts full rerolls and single-card rerolls separately, for skills and items. These rules belong to this build.</small>
        </div>
        <div class="roa-section">
          <b>Skill upgrade priority</b>
          ${UPGRADE_HEAD}
          <div class="roa-upgrades" data-kind="skill" data-group="-1">
            ${build.skillUpgrades
              .map((row, index) =>
                upgradeRowHtml(row, index, "skill", focusedSkill(row.name), -1, build),
              )
              .join("")}
          </div>
          ${addRowHtml("skill", -1, build)}
          <small>Limit stops this upgrade after the skill summary reaches that total (0 = unlimited).</small>
        </div>
        <div class="roa-section">
          <b>Item priority groups</b>
          <small>Higher groups are checked first. Only the first group can be mandatory. Drag ⋮⋮ to reorder, also between groups.</small>
          ${groups
            .map(
              (group, groupIndex) => `<div class="roa-item-group">
                <div class="roa-group-head">
                  <button type="button" class="ro-btn small" data-click="group-move" data-group="${groupIndex}" data-dir="-1" title="Move group up" ${groupIndex === 0 ? "disabled" : ""}>↑</button>
                  <button type="button" class="ro-btn small" data-click="group-move" data-group="${groupIndex}" data-dir="1" title="Move group down" ${groupIndex === groups.length - 1 ? "disabled" : ""}>↓</button>
                  <input type="text" class="roa-grow" data-input="group-name" data-group="${groupIndex}" value="${esc(group.name)}" maxlength="60" aria-label="Group name">
                  ${
                    groupIndex === 0
                      ? checkHtml('data-change="group-mandatory"', group.mandatory, "Mandatory")
                      : ""
                  }
                  <button type="button" class="ro-btn small" data-click="group-remove" data-group="${groupIndex}" title="Remove group" ${groups.length <= 1 ? "disabled" : ""}>×</button>
                </div>
                ${UPGRADE_HEAD}
                <div class="roa-upgrades" data-kind="item" data-group="${groupIndex}">
                  ${group.rows
                    .map((row, index) =>
                      upgradeRowHtml(row, index, "item", build.focusItems.includes(row.name), groupIndex, build),
                    )
                    .join("")}
                </div>
                ${addRowHtml("item", groupIndex, build)}
              </div>`,
            )
            .join("")}
          <button type="button" class="ro-btn" data-click="group-add">+ Add priority group</button>
        </div>`;
    };

    const lootViewHtml = () => {
      const rules = pickupData.rules;
      const names = manifestData?.names ?? [];
      return `
        <div class="roa-section">
          <b>Item rules</b>
          <small>Need / Greed / Pass for party loot. The longest matching name wins; use <b>*</b> as the name for “any item of this quality or better”.</small>
          <div class="roa-loot-rule roa-loot-head">
            <small>Name contains</small><small>Rarity and higher</small><small>Action</small><span></span>
          </div>
          <div class="roa-loot-rules">
            ${
              rules.length
                ? rules
                    .map(
                      (rule, index) => `<div class="roa-loot-rule" data-index="${index}">
                        <input type="text" list="roa-item-names" data-input="loot-name" value="${esc(rule.name)}" maxlength="80" aria-label="Item name">
                        <select data-change="loot-quality" title="Only apply this rule when the item quality is at least this value">${qualityOptions(rule.quality)}</select>
                        <select data-change="loot-action">${actionOptions(rule.action)}</select>
                        <button type="button" class="ro-btn small" data-click="loot-remove" title="Remove">×</button>
                      </div>`,
                    )
                    .join("")
                : `<small>No item rules yet.</small>`
            }
          </div>
          <div class="roa-loot-rule roa-loot-add">
            <input type="text" list="roa-item-names" class="roa-loot-add-name" data-key="loot-add" placeholder="Search item name…" maxlength="80" aria-label="New rule name">
            <select class="roa-loot-add-quality" aria-label="Quality">${qualityOptions(-1)}</select>
            <select class="roa-loot-add-action" aria-label="Action">${actionOptions("need")}</select>
            <button type="button" class="ro-btn" data-click="loot-add" title="Add rule">Add</button>
          </div>
          ${
            manifestLoading
              ? `<small>Fetching item names…</small>`
              : manifestError
                ? `<small>Could not fetch the item list; type a name manually. <button type="button" class="ro-btn small" data-click="loot-reload">Reload list</button></small>`
                : `<small>${names.length} item names available.</small>`
          }
          <datalist id="roa-item-names">
            ${names.map((name) => `<option value="${esc(name)}"></option>`).join("")}
          </datalist>
        </div>
        <div class="roa-section">
          <b>Other items</b>
          <div class="roa-row">
            <span>Items not matched by a rule</span>
            <select data-change="loot-other">${actionOptions(pickupData.other)}</select>
          </div>
        </div>`;
    };

    // ------------------------------------------------------------ cards --
    const cardStatKind = (line) => {
      const value = line
        .replace(/^[+-]?\d+(?:\.\d+)?%?\s*/, "")
        .replace(/\s+while moving$/, "")
        .trim();
      return /^you revive/i.test(value) ? "revive" : value;
    };
    const cardSlots = [...new Set(CARDS.map((card) => card.slot))].sort();
    const cardStatKinds = [
      ...new Set(CARDS.flatMap((card) => card.stats.map(cardStatKind))),
    ].sort((a, b) => a.localeCompare(b));
    const filteredCards = () => {
      const query = cardFilter.query.trim().toLowerCase();
      return CARDS.filter((card) => {
        if (cardFilter.slot && card.slot !== cardFilter.slot) return false;
        if (
          cardFilter.stat &&
          !card.stats.some((line) => cardStatKind(line) === cardFilter.stat)
        ) {
          return false;
        }
        if (!query) return true;
        return (
          card.name.toLowerCase().includes(query) ||
          card.dropper.toLowerCase().includes(query) ||
          card.slot.toLowerCase().includes(query) ||
          card.stats.join(" ").toLowerCase().includes(query)
        );
      });
    };
    const cardListHtml = () =>
      filteredCards()
        .map(
          (card) => `<div class="roa-card">
            <img src="${esc(card.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">
            <div class="roa-card-info">
              <b>${esc(card.name)}</b>
              <small><span>${esc(card.slot)}</span> · ${esc(card.dropper)}</small>
              ${card.stats.map((line) => `<i>${esc(line)}</i>`).join("")}
            </div>
          </div>`,
        )
        .join("");
    const updateCardList = () => {
      const list = $("#roa-card-list");
      if (!list) return;
      const shown = filteredCards();
      list.innerHTML = shown.length
        ? cardListHtml()
        : `<small>No cards match these filters.</small>`;
      const count = $("#roa-card-count");
      if (count) count.textContent = `${shown.length} / ${CARDS.length}`;
    };
    const cardsViewHtml = () => `
      <div class="roa-section">
        <div class="roa-row">
          <b class="roa-grow">Cards</b>
          <small id="roa-card-count">${filteredCards().length} / ${CARDS.length}</small>
        </div>
        <small>Pictures, stats, slot and drop source. Data and images from ro-survivors.com.</small>
        <div class="roa-row roa-card-filters">
          <input type="search" class="roa-grow" data-input="card-query" value="${esc(cardFilter.query)}" placeholder="Search name, stat, dropper…" aria-label="Search cards">
          <select data-change="card-filter" data-field="slot" aria-label="Card slot">
            <option value="">All slots</option>
            ${cardSlots
              .map(
                (slot) =>
                  `<option value="${esc(slot)}" ${slot === cardFilter.slot ? "selected" : ""}>${esc(slot)}</option>`,
              )
              .join("")}
          </select>
          <select data-change="card-filter" data-field="stat" aria-label="Card stat">
            <option value="">All stats</option>
            ${cardStatKinds
              .map(
                (stat) =>
                  `<option value="${esc(stat)}" ${stat === cardFilter.stat ? "selected" : ""}>${esc(stat.charAt(0).toUpperCase() + stat.slice(1))}</option>`,
              )
              .join("")}
          </select>
          <button type="button" class="ro-btn small" data-click="card-clear">Clear</button>
        </div>
        <div class="roa-card-list" id="roa-card-list">${cardListHtml()}</div>
      </div>`;

    const clock = (at) => {
      const date = new Date(at);
      const two = (value) => String(value).padStart(2, "0");
      return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
    };
    const logViewHtml = () => {
      const s = runStats;
      const stats = [
        ["Picked", s.picks],
        ["By hand", s.manualPicks],
        ["Rerolls", s.rerolls],
        ["Card rerolls", s.cardRerolls],
        ["Focus", s.focus],
        ["Banish", s.banish],
        ["Left to me", s.waits],
        ["Need", s.need],
        ["Greed", s.greed],
        ["Pass", s.pass],
      ];
      return `
        <div class="roa-section">
          <b>${runActive ? "This run" : "Last run"}</b>
          <small>${runStatus()}</small>
          <div class="roa-stats">
            ${stats.map(([label, value]) => `<span><b>${value}</b>${label}</span>`).join("")}
          </div>
        </div>
        <div class="roa-section">
          <div class="roa-row">
            <b class="roa-grow">Recent activity</b>
            <button type="button" class="ro-btn small" data-click="log-clear" ${activity.length ? "" : "disabled"}>Clear</button>
          </div>
          <div class="roa-log">
            ${
              activity.length
                ? activity
                    .slice()
                    .reverse()
                    .map(
                      (entry) =>
                        `<div class="roa-log-row roa-log-${esc(entry.kind)}"><time>${clock(entry.at)}</time><span>${esc(entry.message)}</span></div>`,
                    )
                    .join("")
                : `<small>Nothing yet. Picks, rerolls and loot rolls show up here.</small>`
            }
          </div>
        </div>
        ${
          diag.total
            ? `<div class="roa-section">
                <b>Skipped steps</b>
                <small>Something on the page was not what the addon expected, so it skipped a step. Details, in case the game changed:</small>
                <div class="roa-log">${[...diag.errors]
                  .map(
                    ([label, entry]) =>
                      `<div class="roa-log-row"><time>${entry.count}×</time><span>${esc(label)}: ${esc(entry.message)}</span></div>`,
                  )
                  .join("")}</div>
              </div>`
            : ""
        }`;
    };

    const dataViewHtml = () => {
      const detected = [
        ...Object.entries(learnedSkills).flatMap(([job, list]) =>
          list.map((entry) => `${entry.names[0]} (${jobLabel(job)} skill)`),
        ),
        ...learnedItems.map((entry) => `${entry.names[0]} (item)`),
      ];
      return `
        <div class="roa-section">
          <b>Backup</b>
          <small>Builds, loot rules, saved talent and equipment sets and these options are stored in this browser for this site. Export them to keep a copy or move them to another browser.</small>
          <div class="roa-row">
            <button type="button" class="ro-btn" data-click="export-file">Export to a file</button>
            <button type="button" class="ro-btn" data-click="export-copy">Copy as text</button>
          </div>
          <div class="roa-row">
            <button type="button" class="ro-btn" data-click="import-file">Import from a file…</button>
            <button type="button" class="ro-btn" data-click="import-paste">Paste text…</button>
            <input type="file" class="roa-file" accept=".json,application/json,text/plain" data-change="import-chosen" hidden>
          </div>
          ${undoSnapshot ? `<div class="roa-row"><button type="button" class="ro-btn" data-click="undo">Undo the last import / reset</button></div>` : ""}
          <small>${
            extStorage()
              ? mirrorSavedAt
                ? `A safety copy is kept by the extension (last saved ${clock(mirrorSavedAt)}). It is restored automatically if this site's data is ever cleared.`
                : "A safety copy is kept by the extension and restored automatically if this site's data is ever cleared."
              : "Safety copy unavailable (reload the page after updating the extension)."
          }</small>
        </div>
        <div class="roa-section">
          <b>Game data</b>
          <small>${
            gameDataInfo
              ? `From the game: ${gameDataInfo.skills} skills, ${gameDataInfo.items} items, ${gameDataInfo.classes} classes${gameDataInfo.talents ? `, ${gameDataInfo.talents} talents` : ""}${gameDataInfo.at ? ` (loaded ${clock(gameDataInfo.at)})` : ""}.`
              : "Using the built-in tables. Live game data was not found on this page."
          }</small>
        </div>
        <div class="roa-section">
          <b>Detected cards</b>
          <small>Skills and items the built-in list does not know are remembered when they appear, so you can add them to a build.</small>
          ${
            detected.length
              ? `<div class="roa-log">${detected.map((name) => `<div class="roa-log-row"><span>${esc(name)}</span></div>`).join("")}</div>
                 <div class="roa-row"><button type="button" class="ro-btn" data-click="forget-learned">Forget detected cards</button></div>`
              : `<small>None so far.</small>`
          }
        </div>
        <div class="roa-section">
          <b>Start over</b>
          <div class="roa-row"><button type="button" class="ro-btn roa-danger" data-click="reset-all">Reset all addon data…</button></div>
        </div>`;
    };

    // ------------------------------------------------------------- render --
    const focusables = (scope) =>
      $$("button, select, input, textarea", scope).filter((el) => !el.disabled);
    const renderPanel = () => {
      const overlay = panelEl();
      if (!overlay) return;
      if (!SKILLS[settingsClass]) settingsClass = "swordsman";
      if (panelView === "build" && !editingBuild()) {
        panelView = "builds";
        editingBuildId = null;
      }
      if (!TABS.some(([id]) => id === panelView) && panelView !== "build") {
        panelView = "general";
      }
      const viewKey = `${panelView}:${editingBuildId ?? ""}:${settingsClass}`;
      const sameView = viewKey === renderedView;
      renderedView = viewKey;
      const oldBody = overlay.querySelector(".roa-panel-body");
      const scroll = sameView ? (oldBody?.scrollTop ?? 0) : 0;
      let focusIndex = -1;
      let focusTag = "";
      const focused = document.activeElement;
      if (sameView && focused && overlay.contains(focused)) {
        focusIndex = focusables(overlay).indexOf(focused);
        focusTag = focused.tagName;
      }
      const body =
        panelView === "build"
          ? buildViewHtml(editingBuild())
          : panelView === "builds"
            ? buildsViewHtml()
            : panelView === "move"
              ? moveViewHtml()
              : panelView === "loot"
                ? lootViewHtml()
                : panelView === "cards"
                  ? cardsViewHtml()
                  : panelView === "log"
                    ? logViewHtml()
                    : panelView === "data"
                      ? dataViewHtml()
                      : generalViewHtml();
      overlay.innerHTML = `<div class="ro-window roa-modal">${headHtml()}<div class="ro-body roa-panel-body">${panelNavHtml()}${body}</div></div>`;
      const panelBody = overlay.querySelector(".roa-panel-body");
      if (panelBody) panelBody.scrollTop = scroll;
      if (focusIndex >= 0) {
        const next = focusables(overlay)[focusIndex];
        if (next && next.tagName === focusTag) {
          try {
            next.focus({ preventScroll: true });
          } catch {}
        }
      }
    };

    // ----------------------------------------------------- import / export --
    const exportPayload = () => {
      flushSaves();
      const data = {};
      for (const key of DATA_KEYS) {
        const raw = ls.get(key);
        if (raw == null) continue;
        if (JSON_KEYS.has(key)) {
          try {
            data[key] = JSON.parse(raw);
          } catch {
            data[key] = raw;
          }
        } else {
          data[key] = raw;
        }
      }
      return {
        app: APP_ID,
        type: "backup",
        format: 1,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        data,
      };
    };
    const buildPayload = (job, build) => ({
      app: APP_ID,
      type: "build",
      format: 1,
      version: VERSION,
      job,
      build: JSON.parse(JSON.stringify(build)),
    });
    const downloadText = (filename, value) => {
      const blob = new Blob([value], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };
    const copyText = async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {}
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.append(area);
        area.select();
        const done = document.execCommand("copy");
        area.remove();
        return !!done;
      } catch {
        return false;
      }
    };
    const offerCopy = async (title, value, doneMessage) => {
      if (await copyText(value)) {
        notify(doneMessage, "info");
        return;
      }
      await openDialog({
        title,
        message: "Copying was blocked by the browser. Select the text below and copy it.",
        input: value,
        multiline: true,
        cancel: false,
        okLabel: "Close",
      });
    };

    // Re-read everything from storage (after an import, a reset, or a change
    // made in another tab).
    const reloadState = () => {
      pendingSaves.clear();
      loadFlags();
      opts = normalizeOptions(ls.json(KEYS.options, null));
      loadLearned();
      buildData = loadBuildData();
      pickupData = loadPickupData();
      skillBuilds = readSkillBuilds();
      equipBuilds = readEquipBuilds();
      const savedClass = ls.get(KEYS.settingsClass);
      if (savedClass && SKILLS[savedClass]) settingsClass = savedClass;
      const job = cls || activeBuildClass || settingsClass;
      activeBuildClass = null;
      resolveActiveBuild(SKILLS[job] ? job : "swordsman");
      refreshToolLists();
      refreshUi();
    };
    // ------------------------------------------------------- game data sync --
    const postToWindow = (message) => {
      try {
        window.postMessage(
          message,
          location.origin && location.origin !== "null"
            ? location.origin
            : "*",
        );
      } catch {}
    };
    const applyCachedGameData = () => {
      const raw = ls.json(KEYS.gameData, null);
      if (!raw || raw.v !== GAMEDATA_VERSION || !raw.payload) return false;
      const info = applyGameData(raw.payload);
      if (!info) return false;
      gameDataSignature = typeof raw.signature === "string" ? raw.signature : "";
      gameDataInfo = { ...info, at: Number(raw.at) || 0 };
      return true;
    };
    let gameDataRetries = 0;
    const requestGameData = () => {
      if (gameDataSeen || gameDataRetries >= 8) return;
      gameDataRetries += 1;
      postToWindow({ __roAutoWantData: 1 });
      setTimeout(guard("gamedata", requestGameData), 1500);
    };
    const onGameDataMessage = guard("gamedata", (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.__roAutoGameData !== GAMEDATA_VERSION) return;
      const payload = event.data.payload;
      if (!payload || typeof payload !== "object") return;
      const signature =
        typeof payload.signature === "string" ? payload.signature : "";
      gameDataSeen = true;
      if (signature && signature === gameDataSignature) {
        postToWindow({ __roAutoDataAck: 1 });
        return;
      }
      const info = applyGameData(payload);
      if (!info) {
        noteError("gamedata", new Error("unusable game data payload"));
        return;
      }
      gameDataSignature = signature;
      gameDataInfo = { ...info, at: nowMs() };
      saveNow(
        KEYS.gameData,
        JSON.stringify({
          v: GAMEDATA_VERSION,
          at: nowMs(),
          signature,
          payload,
        }),
      );
      reloadState();
      // Normalising the builds above cleared any save still in the queue.
      saveBuildData();
      logEvent(
        "info",
        `Live game data: ${info.skills} skills, ${info.items} items.`,
        { toast: false },
      );
      postToWindow({ __roAutoDataAck: 1 });
    });
    const replaceAllData = (keys) => {
      flushSaves();
      undoSnapshot = snapshotKeys();
      for (const key of DATA_KEYS) ls.remove(key);
      for (const [key, value] of Object.entries(keys)) {
        if (DATA_KEYS.includes(key) && typeof value === "string") {
          ls.set(key, value);
        }
      }
      reloadState();
      saveNow(KEYS.builds, JSON.stringify(buildData));
    };

    const importBuildPayload = (payload) => {
      const job = SKILLS[payload.job] ? payload.job : settingsClass;
      if (!payload.build || typeof payload.build !== "object") return false;
      const bucket = classBuilds(job);
      const build = cloneBuild(
        normalizeBuild(JSON.parse(JSON.stringify(payload.build))),
        uniqueBuildName(
          bucket,
          String(payload.build.name || "Imported build").trim().slice(0, 60) ||
            "Imported build",
        ),
      );
      bucket.builds.push(build);
      if (!bucket.active) bucket.active = build.id;
      saveBuildData();
      settingsClass = job;
      saveNow(KEYS.settingsClass, settingsClass);
      editingBuildId = build.id;
      panelView = "build";
      renderPanel();
      notify(`Added “${build.name}” to ${jobLabel(job)}.`);
      return true;
    };
    const applyImport = async (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw ?? "").trim());
      } catch {
        await uiAlert("Import failed", "That is not valid backup text.");
        return false;
      }
      if (payload && payload.app === APP_ID && payload.type === "build") {
        if (importBuildPayload(payload)) return true;
        await uiAlert("Import failed", "That build could not be read.");
        return false;
      }
      // A bare builds object (the raw "ro-auto-builds" value) is accepted too.
      let data = payload && payload.app === APP_ID ? payload.data : null;
      if (!data && payload && typeof payload.classes === "object" && payload.classes) {
        data = { [KEYS.builds]: payload };
      }
      if (!data || typeof data !== "object") {
        await uiAlert(
          "Import failed",
          "This was not exported by RO Survivors Auto Picker.",
        );
        return false;
      }
      const keys = {};
      for (const key of DATA_KEYS) {
        if (!Object.hasOwn(data, key)) continue;
        const value = data[key];
        if (JSON_KEYS.has(key)) {
          if (value && typeof value === "object") {
            keys[key] = JSON.stringify(value);
          } else if (typeof value === "string") {
            try {
              JSON.parse(value);
              keys[key] = value;
            } catch {}
          }
        } else if (typeof value === "string" && value.length < 64) {
          keys[key] = value;
        }
      }
      if (!Object.keys(keys).length) {
        await uiAlert("Import failed", "The backup holds nothing to import.");
        return false;
      }
      const ok = await uiConfirm(
        "Replace addon data?",
        "Everything the addon has saved here will be replaced by the backup. You can undo this until the page is reloaded.",
        { okLabel: "Replace" },
      );
      if (!ok) return false;
      // Parts the backup does not carry are kept as they are.
      flushSaves();
      replaceAllData({ ...snapshotKeys(), ...keys });
      notify("Backup imported.");
      return true;
    };

    // ----------------------------------------------------------- handlers --
    const withBuild = (fn) => (el, event) => {
      const build = editingBuild();
      if (build) fn(build, el, event);
    };
    const rowContext = (el, build) => {
      const rowEl = el.closest(".roa-upgrade");
      if (!rowEl) return null;
      const kind = rowEl.dataset.kind;
      const groupIndex = Number(rowEl.dataset.group);
      const index = Number(rowEl.dataset.index);
      const rows =
        kind === "skill"
          ? build.skillUpgrades
          : build.itemGroups[groupIndex]?.rows;
      const row = rows?.[index];
      return row ? { kind, groupIndex, index, rows, row } : null;
    };
    const rowsOf = (build, kind, groupIndex) =>
      kind === "skill" ? build.skillUpgrades : build.itemGroups[groupIndex]?.rows;
    const toggleIn = (list, id) => {
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      else list.push(id);
    };
    const findBuild = (id) =>
      classBuilds(settingsClass).builds.find((build) => build.id === id) ?? null;
    const uniqueBuildName = (bucket, wanted) => {
      const names = new Set(bucket.builds.map((build) => build.name));
      if (!names.has(wanted)) return wanted;
      for (let n = 2; n < 200; n++) {
        const candidate = `${wanted} (${n})`.slice(0, 60);
        if (!names.has(candidate)) return candidate;
      }
      return wanted;
    };
    const useBuild = (build) => {
      setActiveBuild(settingsClass, build);
      if (runActive && activeBuildClass === settingsClass) {
        promptChoiceName = build.name;
        notify(`Now using “${build.name}”.`);
      }
      refreshUi();
    };

    const CLICK = {
      close: () => closePanel(),
      tab: (el) => {
        panelView = el.dataset.tab;
        editingBuildId = null;
        if (panelView === "loot") loadManifest();
        renderPanel();
      },
      power: () => setEnabled(!enabled),
      back: () => {
        panelView = "builds";
        editingBuildId = null;
        renderPanel();
      },

      // -- build list
      "build-open": (el) => {
        editingBuildId = el.dataset.id;
        panelView = "build";
        renderPanel();
      },
      "build-use": (el) => {
        const build = findBuild(el.dataset.id);
        if (build) useBuild(build);
      },
      "build-move": (el) => {
        const builds = classBuilds(settingsClass).builds;
        const from = builds.findIndex((build) => build.id === el.dataset.id);
        const to = from + Number(el.dataset.dir);
        if (from < 0 || to < 0 || to >= builds.length) return;
        [builds[from], builds[to]] = [builds[to], builds[from]];
        saveBuildData();
        renderPanel();
      },
      "build-copy": (el) => {
        const bucket = classBuilds(settingsClass);
        const base = findBuild(el.dataset.id);
        if (!base) return;
        const copy = cloneBuild(base, uniqueBuildName(bucket, `${base.name} copy`.slice(0, 60)));
        bucket.builds.splice(bucket.builds.indexOf(base) + 1, 0, copy);
        saveBuildData();
        editingBuildId = copy.id;
        panelView = "build";
        renderPanel();
      },
      "build-share": async (el) => {
        const build = findBuild(el.dataset.id);
        if (!build) return;
        await offerCopy(
          "Build as text",
          JSON.stringify(buildPayload(settingsClass, build)),
          `“${build.name}” copied. Paste it on the Builds tab of another browser.`,
        );
      },
      "build-remove": async (el) => {
        const job = settingsClass;
        const bucket = classBuilds(job);
        const target = bucket.builds.find((build) => build.id === el.dataset.id);
        if (!target) return;
        const ok = await uiConfirm(`Remove “${target.name}”?`, "", {
          okLabel: "Remove",
          danger: true,
        });
        if (!ok || !bucket.builds.includes(target)) return;
        bucket.builds = bucket.builds.filter((build) => build !== target);
        if (bucket.active === target.id) {
          bucket.active = bucket.builds[0]?.id ?? null;
        }
        if (activeBuildClass === job && activeBuild === target) {
          activeBuild =
            bucket.builds.find((build) => build.id === bucket.active) ??
            bucket.builds[0] ??
            null;
        }
        if (editingBuildId === target.id) {
          editingBuildId = null;
          panelView = "builds";
        }
        saveBuildData();
        refreshUi();
      },
      "build-add": async () => {
        const job = settingsClass;
        const bucket = classBuilds(job);
        const name = await uiPrompt("Build name", `Build ${bucket.builds.length + 1}`);
        if (!name || !name.trim()) return;
        const build = makeDefaultBuild(job, LOADOUTS[0]);
        build.name = uniqueBuildName(bucket, name.trim().slice(0, 60));
        build.id = "b" + shortId();
        bucket.builds.push(build);
        if (!bucket.active) bucket.active = build.id;
        if (activeBuildClass === job && !activeBuild) activeBuild = build;
        saveBuildData();
        settingsClass = job;
        editingBuildId = build.id;
        panelView = "build";
        refreshUi();
      },
      "build-paste": async () => {
        const raw = await uiPrompt("Paste a build", "", {
          multiline: true,
          message: "Paste the text from “Copy as text”.",
          okLabel: "Add build",
        });
        if (raw && raw.trim()) await applyImport(raw);
      },
      "build-defaults": () => {
        const bucket = classBuilds(settingsClass);
        const names = new Set(bucket.builds.map((build) => build.name));
        let added = 0;
        for (const loadout of LOADOUTS) {
          if (names.has(loadout.name)) continue;
          bucket.builds.push(makeDefaultBuild(settingsClass, loadout));
          added += 1;
        }
        if (!bucket.active) bucket.active = bucket.builds[0]?.id ?? null;
        if (activeBuildClass === settingsClass && !activeBuild) {
          resolveActiveBuild(settingsClass);
        }
        saveBuildData();
        refreshUi();
        notify(
          added
            ? `Added ${added} default build${added === 1 ? "" : "s"}.`
            : "All default builds are already there.",
        );
      },

      // -- build editor
      "req-move": withBuild((build, el) => {
        const index = Number(el.dataset.index);
        const other = index + Number(el.dataset.dir);
        if (other < 0 || other > 3) return;
        [build.required[index], build.required[other]] = [
          build.required[other],
          build.required[index],
        ];
        saveBuildData();
        renderPanel();
      }),
      "req-focus": withBuild((build, el) => {
        const skill = build.required[Number(el.dataset.index)];
        if (!skill) return;
        toggleIn(build.focusSkills, skill);
        saveBuildData();
        renderPanel();
      }),
      "row-focus": withBuild((build, el) => {
        const ctx = rowContext(el, build);
        if (!ctx || !ctx.row.name) return;
        if (ctx.kind === "skill" && ctx.row.name === AUTO_SKILL.id) {
          build.autoMode = build.autoMode === "focus" ? "normal" : "focus";
        } else {
          toggleIn(
            ctx.kind === "skill" ? build.focusSkills : build.focusItems,
            ctx.row.name,
          );
        }
        saveBuildData();
        renderPanel();
      }),
      "row-remove": withBuild((build, el) => {
        const ctx = rowContext(el, build);
        if (!ctx) return;
        ctx.rows.splice(ctx.index, 1);
        runPickValues.delete(ctx.row.id);
        saveBuildData();
        renderPanel();
      }),
      "row-add": withBuild((build, el) => {
        const addRow = el.closest(".roa-add-row");
        if (!addRow) return;
        const name = addRow.querySelector(".roa-add-name").value;
        if (!name) return;
        const rows = rowsOf(build, addRow.dataset.kind, Number(addRow.dataset.group));
        if (!rows) return;
        rows.push(
          makeRow(
            name,
            addRow.querySelector(".roa-add-upgrade").value || "any",
            addRow.querySelector(".roa-add-limit").value,
          ),
        );
        saveBuildData();
        renderPanel();
      }),
      "group-move": withBuild((build, el) => {
        const index = Number(el.dataset.group);
        const other = index + Number(el.dataset.dir);
        if (other < 0 || other >= build.itemGroups.length) return;
        [build.itemGroups[index], build.itemGroups[other]] = [
          build.itemGroups[other],
          build.itemGroups[index],
        ];
        build.itemGroups.forEach((group, at) => {
          if (at !== 0) group.mandatory = false;
        });
        saveBuildData();
        renderPanel();
      }),
      "group-remove": withBuild((build, el) => {
        if (build.itemGroups.length <= 1) return;
        build.itemGroups.splice(Number(el.dataset.group), 1);
        build.itemGroups.forEach((group, at) => {
          if (at !== 0) group.mandatory = false;
        });
        saveBuildData();
        renderPanel();
      }),
      "group-add": withBuild((build) => {
        build.itemGroups.push({
          id: newRowId(),
          name: `Group ${build.itemGroups.length + 1}`,
          mandatory: false,
          rows: [],
        });
        saveBuildData();
        renderPanel();
      }),

      // -- loot
      "loot-remove": (el) => {
        const index = Number(el.closest(".roa-loot-rule")?.dataset.index);
        if (!pickupData.rules[index]) return;
        pickupData.rules.splice(index, 1);
        savePickupData();
        renderPanel();
      },
      "loot-add": (el) => {
        const box = el.closest(".roa-loot-add");
        const input = box?.querySelector(".roa-loot-add-name");
        const name = (input?.value || "").trim();
        if (!name) return;
        const quality = clamp(Number(box.querySelector(".roa-loot-add-quality").value), -1, 4);
        const action = box.querySelector(".roa-loot-add-action").value;
        const twin = pickupData.rules.find(
          (rule) => lower(rule.name) === lower(name) && rule.quality === quality,
        );
        if (twin) {
          twin.action = ACTION_VALUES.includes(action) ? action : twin.action;
        } else {
          pickupData.rules.push({
            name,
            quality: Number.isInteger(quality) ? quality : -1,
            action: ACTION_VALUES.includes(action) ? action : "pass",
          });
        }
        savePickupData();
        renderPanel();
        panelEl()?.querySelector(".roa-loot-add-name")?.focus();
      },
      "loot-reload": () => {
        loadManifest(true);
        renderPanel();
      },

      // -- cards
      "card-clear": () => {
        cardFilter.query = "";
        cardFilter.slot = "";
        cardFilter.stat = "";
        renderPanel();
      },

      // -- activity
      "log-clear": () => {
        activity.length = 0;
        diag.errors.clear();
        diag.total = 0;
        saveActivity();
        saveDiag();
        renderPanel();
      },

      // -- backup
      "export-file": () => {
        const stamp = new Date().toISOString().slice(0, 10);
        downloadText(
          `ro-survivors-autopick-backup-${stamp}.json`,
          JSON.stringify(exportPayload(), null, 2),
        );
        notify("Backup file saved to your downloads.");
      },
      "export-copy": () =>
        offerCopy("Backup as text", JSON.stringify(exportPayload()), "Backup copied."),
      "import-file": () => panelEl()?.querySelector(".roa-file")?.click(),
      "import-paste": async () => {
        const raw = await uiPrompt("Paste a backup", "", {
          multiline: true,
          message: "Paste the text of a backup or of a single build.",
          okLabel: "Import",
        });
        if (raw && raw.trim()) await applyImport(raw);
      },
      undo: () => {
        if (!undoSnapshot) return;
        const previous = undoSnapshot;
        replaceAllData(previous);
        undoSnapshot = null;
        renderPanel();
        notify("Put back what was there before.");
      },
      "forget-learned": async () => {
        const ok = await uiConfirm(
          "Forget detected cards?",
          "Builds that use them keep the entry, but it will show as an unknown name until the card appears again.",
          { okLabel: "Forget" },
        );
        if (!ok) return;
        forgetLearned();
        saveNow(KEYS.learned, JSON.stringify(learnedPayload()));
        renderPanel();
      },
      "reset-all": async () => {
        const ok = await uiConfirm(
          "Reset all addon data?",
          "Builds, loot rules, saved talent and equipment sets and options go back to the defaults. You can undo this until the page is reloaded.",
          { okLabel: "Reset", danger: true },
        );
        if (!ok) return;
        clearMirror();
        replaceAllData({});
        notify("Everything is back to the defaults.");
      },
    };

    const CHANGE = {
      flag: (el) => {
        const value = el.checked;
        if (el.dataset.flag === "priority") setPriorityEnabled(value);
        else if (el.dataset.flag === "pickup") setPickupEnabled(value);
        else if (el.dataset.flag === "move") setAutoMove(value);
      },
      opt: (el) => {
        if (Object.hasOwn(defaultOptions(), el.dataset.opt)) {
          setOption(el.dataset.opt, el.checked);
        }
      },
      move: (el) => {
        const key = el.dataset.move;
        if (key === "pattern") {
          if (Object.hasOwn(MOVE_PATTERNS, el.value)) opts.move.pattern = el.value;
        } else if (key === "step" || key === "interval") {
          const value = Number(el.value);
          if (Number.isFinite(value)) opts.move[key] = value;
        } else if (key === "itemRarity") {
          const value = Number(el.value);
          if (Number.isFinite(value)) opts.move.itemRarity = value;
        }
        opts = normalizeOptions(opts);
        moveState.nextAt = 0;
        moveState.target = null;
        moveState.progress = null;
        saveOptions();
      },
      "move-flag": (el) => {
        const flag = el.dataset.flag;
        if (
          ![
            "wasd",
            "yieldToManual",
            "onlyInRun",
            "collectChests",
            "collectMagnets",
            "collectItems",
          ].includes(flag)
        ) {
          return;
        }
        opts.move[flag] = el.checked;
        if (flag === "wasd") {
          releaseLootKeys();
          moveState.nextAt = 0;
          moveState.progress = null;
        }
        saveOptions();
      },
      job: (el) => {
        if (!SKILLS[el.value]) return;
        settingsClass = el.value;
        saveNow(KEYS.settingsClass, settingsClass);
        panelView = "builds";
        editingBuildId = null;
        renderPanel();
      },
      "build-name-done": withBuild((build, el) => {
        const name = el.value.trim().slice(0, 60);
        build.name = name || "Build";
        saveBuildData();
        refreshUi();
      }),
      req: withBuild((build, el) => {
        const index = Number(el.dataset.index);
        const value = el.value;
        const previous = build.required[index];
        if (value) {
          build.required.forEach((id, other) => {
            if (other !== index && id === value) build.required[other] = "";
          });
        }
        build.required[index] = value;
        if (previous && previous !== value && !build.required.includes(previous)) {
          build.skillUpgrades = build.skillUpgrades.filter(
            (row) => row.name !== previous,
          );
          build.focusSkills = build.focusSkills.filter((id) => id !== previous);
        }
        // A newly required skill starts with its usual upgrade rows.
        const entry = value ? skillById.get(value) : null;
        if (entry && !build.skillUpgrades.some((row) => row.name === value)) {
          const rows = defaultUpgradeAspects(entry, 3).map((stat) =>
            makeRow(value, stat),
          );
          const at = build.skillUpgrades.findIndex(
            (row) => row.name === AUTO_SKILL.id,
          );
          build.skillUpgrades.splice(
            at < 0 ? build.skillUpgrades.length : at,
            0,
            ...rows,
          );
        }
        saveBuildData();
        renderPanel();
      }),
      "auto-mode": withBuild((build, el) => {
        if (!AUTO_MODES.includes(el.value)) return;
        build.autoMode = el.value;
        saveBuildData();
        renderPanel();
      }),
      "build-flag": withBuild((build, el) => {
        const flag = el.dataset.flag;
        if (typeof build[flag] !== "boolean") return;
        build[flag] = el.dataset.invert ? !el.checked : el.checked;
        saveBuildData();
      }),
      "group-mandatory": withBuild((build, el) => {
        const group = build.itemGroups[0];
        if (!group) return;
        group.mandatory = el.checked;
        saveBuildData();
        renderPanel();
      }),
      "row-name": withBuild((build, el) => {
        const ctx = rowContext(el, build);
        if (!ctx || !el.value) return;
        ctx.row.name = el.value;
        ctx.row.upgrade = "any";
        runPickValues.delete(ctx.row.id);
        saveBuildData();
        renderPanel();
      }),
      "row-stat": withBuild((build, el) => {
        const ctx = rowContext(el, build);
        if (!ctx) return;
        ctx.row.upgrade = el.value || "any";
        runPickValues.delete(ctx.row.id);
        saveBuildData();
      }),
      "add-name": (el) => {
        const addRow = el.closest(".roa-add-row");
        const upgrade = addRow?.querySelector(".roa-add-upgrade");
        if (!upgrade) return;
        const item = addRow.dataset.kind === "item";
        upgrade.innerHTML = statOptions(
          item ? availableItemStats(el.value) : availableSkillAspects(skillById.get(el.value)),
          "any",
          item ? ITEM_STAT_LABELS : STAT_LABELS,
        );
      },
      "loot-quality": (el) => {
        const rule = pickupData.rules[Number(el.closest(".roa-loot-rule")?.dataset.index)];
        if (!rule) return;
        const value = Number(el.value);
        rule.quality = Number.isInteger(value) ? clamp(value, -1, 4) : -1;
        savePickupData();
      },
      "loot-action": (el) => {
        const rule = pickupData.rules[Number(el.closest(".roa-loot-rule")?.dataset.index)];
        if (!rule || !ACTION_VALUES.includes(el.value)) return;
        rule.action = el.value;
        savePickupData();
      },
      "loot-other": (el) => {
        if (!ACTION_VALUES.includes(el.value)) return;
        pickupData.other = el.value;
        savePickupData();
      },
      "card-filter": (el) => {
        const field = el.dataset.field;
        if (field === "slot" || field === "stat") {
          cardFilter[field] = el.value;
          updateCardList();
        }
      },
      "import-chosen": async (el) => {
        const file = el.files?.[0];
        el.value = "";
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          await uiAlert("Import failed", "That file is too large to be a backup.");
          return;
        }
        let raw = "";
        try {
          raw = await file.text();
        } catch {
          await uiAlert("Import failed", "The file could not be read.");
          return;
        }
        await applyImport(raw);
      },
    };

    const INPUT = {
      "build-name": withBuild((build, el) => {
        build.name = el.value.trim().slice(0, 60) || "Build";
        saveBuildData();
      }),
      "max-rerolls": withBuild((build, el) => {
        const value = Number(el.value);
        build.maxRerolls = Number.isFinite(value) ? clamp(Math.round(value), 0, 10) : 3;
        saveBuildData();
      }),
      "row-limit": withBuild((build, el) => {
        const ctx = rowContext(el, build);
        if (!ctx) return;
        ctx.row.limit = cleanLimit(el.value);
        saveBuildData();
      }),
      "group-name": withBuild((build, el) => {
        const group = build.itemGroups[Number(el.dataset.group)];
        if (!group) return;
        group.name = el.value.slice(0, 60);
        saveBuildData();
      }),
      "loot-name": (el) => {
        const rule = pickupData.rules[Number(el.closest(".roa-loot-rule")?.dataset.index)];
        if (!rule) return;
        rule.name = el.value.slice(0, 80);
        savePickupData();
      },
      "card-query": (el) => {
        cardFilter.query = el.value;
        updateCardList();
      },
    };

    const dispatch = (table, attribute, label) => (event) => {
      const el = event.target.closest?.(`[data-${attribute}]`);
      if (!el || el.disabled) return;
      const handler = table[el.dataset[attribute]];
      if (!handler) return;
      try {
        const result = handler(el, event);
        if (result && typeof result.then === "function") {
          result.then(undefined, (error) => noteError(label, error));
        }
      } catch (error) {
        noteError(label, error);
      }
    };

    // ------------------------------------------------------- drag and drop --
    const clearDropMarks = (overlay) => {
      for (const el of $$(".roa-drop", overlay)) el.classList.remove("roa-drop");
    };
    const bindRowDragging = (overlay) => {
      overlay.addEventListener("dragstart", (event) => {
        const handle = event.target.closest?.(".roa-drag");
        const rowEl = handle?.closest(".roa-upgrade");
        if (!rowEl) return;
        dragState = {
          kind: rowEl.dataset.kind,
          groupIndex: Number(rowEl.dataset.group),
          index: Number(rowEl.dataset.index),
        };
        rowEl.classList.add("dragging");
        try {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", "row");
          event.dataTransfer.setDragImage(rowEl, 14, 14);
        } catch {}
      });
      const dropTarget = (event) => {
        if (!dragState) return null;
        const rowEl = event.target.closest?.(".roa-upgrade:not(.roa-upgrade-head)");
        const list = event.target.closest?.(".roa-upgrades") ?? rowEl?.parentElement;
        if (!list || list.dataset.kind !== dragState.kind) return null;
        return { rowEl: rowEl && list.contains(rowEl) ? rowEl : null, list };
      };
      overlay.addEventListener("dragover", (event) => {
        const target = dropTarget(event);
        if (!target) return;
        event.preventDefault();
        clearDropMarks(overlay);
        (target.rowEl ?? target.list).classList.add("roa-drop");
      });
      overlay.addEventListener("drop", (event) => {
        const target = dropTarget(event);
        const build = editingBuild();
        const from = dragState;
        dragState = null;
        clearDropMarks(overlay);
        if (!target || !build || !from) return;
        event.preventDefault();
        const toGroup = Number(target.list.dataset.group);
        const source = rowsOf(build, from.kind, from.groupIndex);
        const dest = rowsOf(build, from.kind, toGroup);
        if (!source || !dest || !source[from.index]) return;
        const toIndex = target.rowEl ? Number(target.rowEl.dataset.index) : dest.length;
        if (source === dest && toIndex === from.index) return;
        const [row] = source.splice(from.index, 1);
        dest.splice(clamp(toIndex, 0, dest.length), 0, row);
        saveBuildData();
        renderPanel();
      });
      overlay.addEventListener("dragend", () => {
        dragState = null;
        clearDropMarks(overlay);
        for (const el of $$(".dragging", overlay)) el.classList.remove("dragging");
      });
    };

    // --------------------------------------------------------- open / close --
    const openPanel = (view = "general", job = null, buildId = null) => {
      if (!document.body) return;
      if (job && SKILLS[job]) settingsClass = job;
      panelView = view;
      editingBuildId = buildId;
      let overlay = panelEl();
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = PANEL_ID;
        shieldKeys(overlay);
        overlay.addEventListener("click", dispatch(CLICK, "click", "panel-click"));
        overlay.addEventListener("change", dispatch(CHANGE, "change", "panel-change"));
        overlay.addEventListener("input", dispatch(INPUT, "input", "panel-input"));
        overlay.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          if (event.target?.dataset?.key !== "loot-add") return;
          event.preventDefault();
          CLICK["loot-add"](event.target);
        });
        bindRowDragging(overlay);
        document.body.append(overlay);
        renderedView = "";
      }
      if (panelView === "loot") loadManifest();
      renderPanel();
      syncCustomizeTriggers();
    };
    const closePanel = () => {
      panelEl()?.remove();
      renderedView = "";
      dragState = null;
      flushSaves();
      syncCustomizeTriggers();
    };
    const togglePanel = () => {
      if (panelOpen()) closePanel();
      else openPanel(panelView === "build" ? "builds" : panelView);
    };

    // =====================================================================
    // 9. Game tools
    // =====================================================================

    // ------------------------------------------------- item name manifest --
    // The game's own list of item and card names, fetched once and shared by
    // the inventory search and the loot rule suggestions.
    let manifestData = null;
    let manifestLoading = false;
    let manifestError = false;
    let manifestPromise = null;
    const loadManifest = (force = false) => {
      if (manifestPromise && !force) return manifestPromise;
      manifestLoading = true;
      manifestError = false;
      manifestPromise = (async () => {
        const urls = [];
        for (const path of ["assets/manifest.json", "/assets/manifest.json"]) {
          try {
            const url = new URL(path, location.href).href;
            if (!urls.includes(url)) urls.push(url);
          } catch {}
        }
        let found = null;
        for (const url of urls) {
          try {
            const response = await fetch(url, { cache: "force-cache" });
            if (!response.ok) continue;
            const manifest = await response.json();
            if (manifest && typeof manifest === "object") {
              found = manifest;
              break;
            }
          } catch {}
        }
        const items = new Map();
        const cards = new Map();
        const names = new Set();
        const collect = (source, into) => {
          if (!source || typeof source !== "object") return;
          for (const [id, entry] of Object.entries(source)) {
            if (!entry?.name) continue;
            into.set(id, String(entry.name));
            names.add(String(entry.name));
          }
        };
        collect(found?.items, items);
        collect(found?.cards, cards);
        manifestData = {
          items,
          cards,
          names: [...names].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "base" }),
          ),
        };
        manifestError = !found;
        manifestLoading = false;
        applyAllInventoryFilters();
        if (panelOpen() && panelView === "loot") renderPanel();
        return manifestData;
      })();
      manifestPromise.then(undefined, (error) => {
        manifestLoading = false;
        manifestError = true;
        noteError("manifest", error);
      });
      return manifestPromise;
    };

    // --------------------------------------------------- inventory search --
    const INV_FILTER_PAIRS = [
      { key: "shop", filter: "shop-filters", items: "shop-items" },
      { key: "cp", filter: "cp-inv-filters", items: "cp-inventory" },
      { key: "tr", filter: "tr-filters", items: "tr-inv" },
    ];
    const invFilterState = {
      shop: { query: "", rarity: -1, tier: 0 },
      cp: { query: "", rarity: -1, tier: 0 },
      tr: { query: "", rarity: -1, tier: 0 },
    };
    const invObservedFilters = new WeakSet();
    const invObservedItems = new WeakSet();

    // Item tier lives on the saved item, not on its cell. The game keeps its
    // save in an encrypted localStorage vault (ro-survivors-sync.<id>) even
    // for guest sessions; the account.v1 document lists every item's uid and
    // tier. A missing tier fails open (the cell stays visible).
    let tierByUid = new Map();
    let tierReadAt = 0;
    let tierLoading = false;
    const collectTiers = (map, data) => {
      for (const item of data?.inventory || []) {
        const uid = item?.uid;
        const tier = Number(item?.tier);
        if (uid && Number.isFinite(tier)) map.set(String(uid), tier);
      }
    };
    const plainTiers = () => {
      const map = new Map();
      try {
        for (const key of Object.keys(localStorage)) {
          if (!key.endsWith("account.v1")) continue;
          collectTiers(map, JSON.parse(localStorage.getItem(key) || "null"));
        }
      } catch {}
      return map;
    };
    const vaultTiers = async () => {
      if (!globalThis.crypto?.subtle) return null;
      let sessions = [];
      for (const key of ["ro-survivors-session", "ro-survivors-guest-session"]) {
        try {
          const session = JSON.parse(localStorage.getItem(key) || "null");
          if (session?.token && session.id != null) sessions.push(session);
        } catch {}
      }
      for (const session of sessions) {
        const raw = localStorage.getItem(`ro-survivors-sync.${session.id}`);
        if (!raw || raw.startsWith("{")) continue;
        try {
          const [ivPart, dataPart] = raw.split(".");
          if (!ivPart || !dataPart) continue;
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`ro-survivors-vault:${session.token}`),
          );
          const key = await crypto.subtle.importKey(
            "raw",
            digest,
            "AES-GCM",
            false,
            ["decrypt"],
          );
          const iv = Uint8Array.from(atob(ivPart), (ch) => ch.charCodeAt(0));
          const bytes = Uint8Array.from(atob(dataPart), (ch) =>
            ch.charCodeAt(0),
          );
          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            bytes,
          );
          const payload = JSON.parse(new TextDecoder().decode(plain));
          const doc = payload?.doc;
          if (!doc) continue;
          const map = new Map();
          for (const [name, value] of Object.entries(doc)) {
            if (!name.endsWith("account.v1")) continue;
            collectTiers(
              map,
              typeof value === "string" ? JSON.parse(value) : value,
            );
          }
          if (map.size) return map;
        } catch {}
      }
      return null;
    };
    const refreshTiers = () => {
      if (tierLoading) return;
      if (nowMs() - tierReadAt < 1000) return;
      tierReadAt = nowMs();
      const plain = plainTiers();
      if (plain.size) {
        tierByUid = plain;
        return;
      }
      tierLoading = true;
      vaultTiers()
        .then((map) => {
          if (!map) return;
          tierByUid = map;
          applyAllInventoryFilters();
        })
        .catch(() => {})
        .finally(() => {
          tierLoading = false;
        });
    };
    const tierForCell = (cell) => {
      const uid = cell.dataset.uid;
      if (!uid) return null;
      refreshTiers();
      return tierByUid.get(String(uid)) ?? null;
    };

    const itemNameForCell = (cell) => {
      const title = cell.title || "";
      if (!manifestData) return title;
      const card = cell.dataset.card;
      if (card) return manifestData.cards.get(card) ?? title;
      const ore = cell.dataset.ore;
      if (ore) return manifestData.items.get(ore) ?? title;
      const src = cell.querySelector("img")?.getAttribute("src") || "";
      const match = src.match(ITEM_SRC);
      if (match) return manifestData.items.get(match[1]) ?? title;
      return title;
    };
    const rarityForCell = (cell) => {
      if (cell.dataset.card || cell.dataset.ore) return null;
      for (let rank = 4; rank >= 0; rank--) {
        if (cell.classList.contains(`q${rank}`)) return rank;
      }
      return cell.classList.contains("rare") ? 2 : 0;
    };
    const applyInventoryFilter = (pair) => {
      const items = document.getElementById(pair.items);
      if (!items) return;
      const state = invFilterState[pair.key];
      const query = state.query.trim().toLowerCase();
      const filtering = !!query || state.rarity >= 0 || state.tier > 0;
      let shown = 0;
      let total = 0;
      for (const cell of items.querySelectorAll(".item-cell")) {
        total += 1;
        const cellTier = state.tier > 0 ? tierForCell(cell) : null;
        const visible =
          !filtering ||
          ((!query || itemNameForCell(cell).toLowerCase().includes(query)) &&
            (state.rarity < 0 || rarityForCell(cell) === state.rarity) &&
            (state.tier <= 0 || cellTier === null || cellTier === state.tier));
        if (visible) {
          shown += 1;
          // Only undo what we hid ourselves.
          if (cell.dataset.roaHidden) {
            delete cell.dataset.roaHidden;
            cell.style.display = "";
          }
        } else if (!cell.dataset.roaHidden) {
          cell.dataset.roaHidden = "1";
          cell.style.display = "none";
        }
      }
      const count = document
        .getElementById(pair.filter)
        ?.querySelector(".ro-inv-count");
      if (count) {
        const label = filtering ? `${shown}/${total}` : "";
        if (count.textContent !== label) count.textContent = label;
      }
    };
    const applyAllInventoryFilters = () => {
      for (const pair of INV_FILTER_PAIRS) applyInventoryFilter(pair);
    };
    const ensureInventoryControls = (filter, pair) => {
      const existing = filter.querySelector(".ro-inv-extra");
      if (existing?.querySelector(".ro-inv-tier")) return;
      // Drop a wrapper left behind by an older build (no tier control).
      if (existing) existing.remove();
      const state = invFilterState[pair.key];
      const wrapper = document.createElement("div");
      wrapper.className = "ro-inv-extra";
      const input = document.createElement("input");
      input.type = "search";
      input.className = "ro-inv-search";
      input.placeholder = "Search item…";
      input.setAttribute("aria-label", "Search items");
      input.value = state.query;
      const select = document.createElement("select");
      select.className = "ro-inv-rarity";
      select.title = "Show only this rarity";
      for (const rank of [-1, 0, 1, 2, 3, 4]) {
        const option = document.createElement("option");
        option.value = String(rank);
        option.textContent = rank < 0 ? "Any" : QUALITY_NAMES[rank];
        select.append(option);
      }
      select.value = String(state.rarity);
      const tier = document.createElement("select");
      tier.className = "ro-inv-tier";
      tier.title = "Show only this item tier";
      for (const value of [0, 1, 2, 3, 4, 5]) {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = value < 1 ? "Any tier" : `Tier ${value}`;
        tier.append(option);
      }
      tier.value = String(state.tier);
      const count = document.createElement("span");
      count.className = "ro-inv-count";
      input.addEventListener("input", () => {
        state.query = input.value;
        applyInventoryFilter(pair);
      });
      select.addEventListener("change", () => {
        state.rarity = Number(select.value);
        applyInventoryFilter(pair);
      });
      tier.addEventListener("change", () => {
        state.tier = Number(tier.value);
        applyInventoryFilter(pair);
      });
      shieldKeys(wrapper);
      wrapper.append(input, select, tier, count);
      filter.append(wrapper);
    };
    const setupInventoryFilters = () => {
      for (const pair of INV_FILTER_PAIRS) {
        const filter = document.getElementById(pair.filter);
        if (filter) {
          ensureInventoryControls(filter, pair);
          if (!invObservedFilters.has(filter)) {
            invObservedFilters.add(filter);
            new MutationObserver(
              guard("inventory", () => ensureInventoryControls(filter, pair)),
            ).observe(filter, { childList: true });
          }
          loadManifest();
        }
        const items = document.getElementById(pair.items);
        if (items) {
          if (!invObservedItems.has(items)) {
            invObservedItems.add(items);
            new MutationObserver(
              guard("inventory", () => applyInventoryFilter(pair)),
            ).observe(items, { childList: true });
          }
          applyInventoryFilter(pair);
        }
      }
    };

    // -------------------------------------------------------- talent sets --
    // These click the game's own talent and reset buttons, one step at a time.
    const validSets = (raw, field) =>
      Array.isArray(raw)
        ? raw.filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.name === "string" &&
              entry[field] &&
              typeof entry[field] === "object",
          )
        : [];
    const readSkillBuilds = () => validSets(ls.json(KEYS.skillBuilds, []), "talents");
    let skillBuilds = [];
    const writeSkillBuilds = () =>
      saveNow(KEYS.skillBuilds, JSON.stringify(skillBuilds));

    const activeTreeJob = () =>
      $("#cp-trees .tree-jobs .tree-job.active") ?? null;
    const talentRank = (element) => {
      const raw = element?.querySelector(".rank")?.textContent || "";
      const match = raw.match(/^\s*(\d+)/);
      return match ? Number(match[1]) : 0;
    };
    const allTalents = () => $$("#cp-trees .talent[data-t]");
    const findTalent = (id) =>
      allTalents().find((node) => node.dataset.t === id) ?? null;

    const readCurrentSkillBuild = () => {
      const trees = $("#cp-trees");
      if (!trees) return null;
      const active = activeTreeJob();
      const talents = {};
      for (const element of trees.querySelectorAll(".talent[data-t]")) {
        const rank = talentRank(element);
        if (rank > 0) talents[element.dataset.t] = rank;
      }
      let spec = null;
      for (const column of trees.querySelectorAll(".tree-col")) {
        if (column.querySelector(".tree-head .spec-tag:not(.off)")) {
          const match = column.className.match(/\bt(\d+)\b/);
          if (match) spec = Number(match[1]);
          break;
        }
      }
      return {
        job: active?.dataset.job || "",
        jobLabel: active
          ? active.textContent.trim().replace(/\s+\d+\/\d+.*$/, "").trim()
          : "",
        spec,
        talents,
      };
    };

    const talentPlusButton = () => {
      const pop = $("#tooltip");
      if (!pop?.classList.contains("talent-pop")) return null;
      const plus = pop.querySelector('.tp-btns button[data-d="1"]');
      return plus && !plus.disabled ? plus : null;
    };
    const addTalentPoint = async (id) => {
      const talent = findTalent(id);
      if (!talent) return false;
      const before = talentRank(talent);
      const raised = () => talentRank(findTalent(id)) > before;
      const clickedAt = nowMs();
      talent.click();
      // The point either lands at once or the game opens its +/- popup.
      const outcome = await waitFor(
        () =>
          raised()
            ? "done"
            : nowMs() - clickedAt >= 12 && talentPlusButton()
              ? "popup"
              : null,
        160,
        6,
      );
      if (outcome === "done") return true;
      if (outcome === "popup") {
        const plus = talentPlusButton();
        if (plus) {
          plus.click();
          return !!(await waitFor(raised, 250, 6));
        }
      }
      return raised();
    };
    const applyTalentBuild = async (targets) => {
      const remaining = new Map(
        Object.entries(targets || {})
          .map(([id, rank]) => [id, Number(rank) || 0])
          .filter(([, rank]) => rank > 0),
      );
      let changed = true;
      for (let pass = 0; pass < 60 && remaining.size && changed; pass++) {
        changed = false;
        for (const [id, target] of Array.from(remaining)) {
          const talent = findTalent(id);
          if (!talent) continue;
          if (talentRank(talent) >= target) {
            remaining.delete(id);
            continue;
          }
          if (await addTalentPoint(id)) {
            changed = true;
            if (talentRank(findTalent(id)) >= target) remaining.delete(id);
          } else if (gameDialogOpen()) {
            return { remaining, blocked: true };
          }
        }
      }
      return { remaining, blocked: false };
    };
    const switchJobTab = async (job) => {
      if (!job) return true;
      const onTab = () => activeTreeJob()?.dataset.job === job;
      if (onTab()) return true;
      const button = $$("#cp-trees .tree-job").find(
        (node) => node.dataset.job === job,
      );
      if (!button || button.classList.contains("soon")) return false;
      button.click();
      await waitFor(onTab, 500, 15);
      await sleep(60);
      return onTab();
    };
    const resetCurrentTalents = async () => {
      const button = $("#cp-reset");
      if (!button || gameDialogOpen()) return false;
      button.click();
      await waitFor(gameDialogOpen, 300, 15);
      if (gameDialogOpen()) {
        const confirm = $("#npc-dialog #npc-options .ro-btn.primary");
        if (!confirm) return false;
        confirm.click();
        await waitFor(() => !gameDialogOpen(), 600, 15);
      }
      await waitFor(
        () => allTalents().every((el) => talentRank(el) === 0),
        500,
        20,
      );
      return !gameDialogOpen();
    };

    let skillBuildBusy = false;
    const loadSkillBuild = guardAsync("talents", async (id) => {
      if (skillBuildBusy) {
        notify("Still applying talents — one moment.");
        return;
      }
      const build = skillBuilds.find((entry) => entry.id === id);
      if (!build) return;
      if (gameDialogOpen()) {
        await uiAlert("Close the open dialog first.", "");
        return;
      }
      skillBuildBusy = true;
      try {
        if (!(await switchJobTab(build.job))) {
          await uiAlert(
            "Wrong job tab",
            `Change to the ${build.jobLabel || build.job} job tab first.`,
          );
          return;
        }
        const currentSpec = readCurrentSkillBuild()?.spec ?? null;
        if (build.spec != null && currentSpec != null && build.spec !== currentSpec) {
          const go = await uiConfirm(
            "Different specialization",
            `“${build.name}” uses a different specialization. Load anyway?`,
            { okLabel: "Load" },
          );
          if (!go) return;
        }
        if (!(await resetCurrentTalents())) {
          await uiAlert(
            "Could not reset talents",
            "Close any open dialog and try again.",
          );
          return;
        }
        const result = await applyTalentBuild(build.talents || {});
        if (result.blocked) {
          await uiAlert(
            "Specialization needed",
            `Choose your specialization in the game dialog, then load “${build.name}” again.`,
          );
          return;
        }
        const left = Array.from(result.remaining.keys());
        if (left.length) {
          const names = left
            .slice(0, 4)
            .map((key) => key.split(".").slice(-1)[0])
            .join(", ");
          await uiAlert(
            `Loaded “${build.name}”`,
            `Could not apply ${left.length} talent(s): ${names}${left.length > 4 ? "…" : ""}.`,
          );
        } else {
          notify(`Loaded “${build.name}”.`);
        }
      } finally {
        skillBuildBusy = false;
      }
    });
    const saveSkillBuild = guardAsync("talents", async () => {
      if (!$("#cp-trees")?.querySelector(".talent")) {
        await uiAlert("No skill tree here to save.", "");
        return;
      }
      const snapshot = readCurrentSkillBuild();
      if (!snapshot) return;
      const count = skillBuilds.filter((build) => build.job === snapshot.job).length;
      const name = await uiPrompt("Skill build name", `Build ${count + 1}`);
      if (!name || !name.trim()) return;
      const clean = name.trim().slice(0, 60);
      const fresh = {
        id: `${Date.now()}-${shortId().slice(0, 5)}`,
        name: clean,
        job: snapshot.job,
        jobLabel: snapshot.jobLabel,
        spec: snapshot.spec,
        talents: snapshot.talents,
        at: Date.now(),
      };
      const twin = skillBuilds.findIndex(
        (build) => build.job === snapshot.job && build.name === clean,
      );
      if (twin >= 0) {
        const replace = await uiConfirm(
          `Replace “${clean}”?`,
          "A saved skill build with this name already exists.",
          { okLabel: "Replace" },
        );
        if (!replace) return;
        fresh.id = skillBuilds[twin].id;
        skillBuilds[twin] = fresh;
      } else {
        skillBuilds.unshift(fresh);
      }
      writeSkillBuilds();
      setupSkillBuilds();
      notify(`Saved “${clean}”.`);
    });
    const deleteSkillBuild = guardAsync("talents", async (id) => {
      const build = skillBuilds.find((entry) => entry.id === id);
      if (!build) return;
      const ok = await uiConfirm(`Delete “${build.name}”?`, "", {
        okLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      skillBuilds = skillBuilds.filter((entry) => entry.id !== id);
      writeSkillBuilds();
      setupSkillBuilds();
    });

    const onSkillBuildClick = (event) => {
      if (event.target.closest(".ro-skill-save")) {
        saveSkillBuild();
        return;
      }
      const load = event.target.closest(".ro-skill-load");
      if (load) {
        loadSkillBuild(load.dataset.id);
        return;
      }
      const remove = event.target.closest(".ro-skill-del");
      if (remove) deleteSkillBuild(remove.dataset.id);
    };
    const setButtonsHtml = (prefix, builds) =>
      builds
        .map(
          (build) =>
            `<span class="${prefix}-item"><button type="button" class="ro-btn small ${prefix}-load" data-id="${esc(build.id)}" title="${esc(build.name)}">${esc(build.name)}</button><button type="button" class="ro-btn small ${prefix}-del" data-id="${esc(build.id)}" title="Delete ${esc(build.name)}">×</button></span>`,
        )
        .join("");
    const renderSkillBuildUi = (jobs) => {
      let wrapper = jobs.querySelector(".ro-skill-builds");
      if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.className = "ro-skill-builds";
        wrapper.innerHTML =
          '<button type="button" class="ro-btn small ro-skill-save" title="Save current skill build">+</button><span class="ro-skill-list"></span>';
        wrapper.addEventListener("click", onSkillBuildClick);
        jobs.append(wrapper);
      }
      const activeJob = jobs.querySelector(".tree-job.active")?.dataset.job || "";
      const builds = skillBuilds.filter(
        (build) => !activeJob || !build.job || build.job === activeJob,
      );
      const signature =
        activeJob + "|" + builds.map((build) => `${build.id}:${build.name}`).join("|");
      const list = wrapper.querySelector(".ro-skill-list");
      if (!list || list.dataset.signature === signature) return;
      list.dataset.signature = signature;
      list.innerHTML = setButtonsHtml("ro-skill", builds);
    };
    let skillBuildObservedTrees = null;
    const setupSkillBuilds = () => {
      const trees = $("#cp-trees");
      if (!trees) return;
      const jobs = trees.querySelector(".tree-jobs");
      if (jobs) renderSkillBuildUi(jobs);
      if (skillBuildObservedTrees !== trees) {
        skillBuildObservedTrees = trees;
        new MutationObserver(guard("talents", () => setupSkillBuilds())).observe(
          trees,
          { childList: true },
        );
      }
    };

    // ----------------------------------------------------- equipment sets --
    // Items are matched by the name and icon the game shows.
    const readEquipBuilds = () => validSets(ls.json(KEYS.equipBuilds, []), "slots");
    let equipBuilds = [];
    const writeEquipBuilds = () =>
      saveNow(KEYS.equipBuilds, JSON.stringify(equipBuilds));

    const equipIconName = (src) =>
      String(src || "")
        .split("/")
        .pop()
        ?.split("?")[0] || "";
    const normalizeEquipName = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const equipSlotEls = () => $$("#cp-tab-equip .equip-slot[data-slot]");
    const findEquipSlot = (slot) =>
      equipSlotEls().find((element) => element.dataset.slot === slot) ?? null;
    const slotItemName = (element) => {
      const name = normalizeEquipName(element?.querySelector(".nm")?.textContent);
      return name && name !== "—" ? name : "";
    };
    const readEquippedBuild = () => {
      const slots = {};
      for (const element of equipSlotEls()) {
        const name = slotItemName(element);
        if (!name) continue;
        slots[element.dataset.slot] = {
          name,
          icon: equipIconName(
            element.querySelector(".ico img")?.getAttribute("src"),
          ),
        };
      }
      return slots;
    };
    const equipCandidateFor = (item) => {
      const named = $$("#cp-eq-list .cand[data-uid]").filter(
        (cand) =>
          normalizeEquipName(cand.querySelector(".cand-info b")?.textContent) ===
          item.name,
      );
      const free = named.filter((cand) => !cand.classList.contains("worn"));
      return (
        free.find(
          (cand) =>
            !item.icon ||
            equipIconName(cand.querySelector(".ico img")?.getAttribute("src")) ===
              item.icon,
        ) ??
        free[0] ??
        null
      );
    };
    // Select the slot, press the game's Unequip button, check that it worked.
    // A slow redraw gets a second and third try with a longer pause.
    const unequipSlot = async (slot) => {
      for (const pause of [30, 90, 220]) {
        const element = findEquipSlot(slot);
        if (!element || !slotItemName(element)) return true;
        element.click();
        await sleep(pause);
        const button = await waitFor(() => $("#cp-unequip"), 250, 15);
        if (!button) continue;
        button.click();
        await sleep(40);
        const freed = await waitFor(
          () => !slotItemName(findEquipSlot(slot)),
          400,
          15,
        );
        if (freed) return true;
      }
      return false;
    };
    const unequipAllEquipment = async () => {
      for (const slot of equipSlotEls().map((element) => element.dataset.slot)) {
        await unequipSlot(slot);
      }
    };

    let equipBuildBusy = false;
    const slotHolds = (slot, item) => {
      const element = findEquipSlot(slot);
      if (!element || slotItemName(element) !== item.name) return false;
      const icon = equipIconName(
        element.querySelector(".ico img")?.getAttribute("src"),
      );
      return !icon || !item.icon || icon === item.icon;
    };
    const equipInto = async (slot, item) => {
      const element = findEquipSlot(slot);
      if (!element) return false;
      element.click();
      await sleep(30);
      const candidate = await waitFor(() => equipCandidateFor(item), 300, 20);
      if (!candidate) return false;
      const equipButton = candidate.querySelector(".cand-eq");
      if (equipButton) {
        equipButton.click();
      } else {
        candidate.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }
      await sleep(50);
      if (gameDialogOpen()) {
        $$("#npc-options .ro-btn")[1]?.click();
        await sleep(40);
      }
      return !!(await waitFor(() => slotHolds(slot, item), 500, 20));
    };
    const loadEquipBuild = guardAsync("equipment", async (id) => {
      if (equipBuildBusy) {
        notify("Still changing equipment — one moment.");
        return;
      }
      const build = equipBuilds.find((entry) => entry.id === id);
      if (!build) return;
      if (gameDialogOpen()) {
        await uiAlert("Close the open dialog first.", "");
        return;
      }
      equipBuildBusy = true;
      let missing = [];
      try {
        const wanted = Object.entries(build.slots || {}).filter(
          ([, item]) => item && typeof item.name === "string" && item.name,
        );
        const wantedBySlot = new Map(wanted);
        // Free every slot that has to change; a slot that already holds
        // the saved item is left alone.
        for (const slot of Object.keys(readEquippedBuild())) {
          const item = wantedBySlot.get(slot);
          if (!item || !slotHolds(slot, item)) await unequipSlot(slot);
        }
        // Fill the slots, then check the result and go again for anything
        // that did not take (the game may still have been redrawing).
        let previous = "";
        for (let pass = 0; pass < 3; pass++) {
          missing = [];
          for (const [slot, item] of wanted) {
            if (slotHolds(slot, item)) continue;
            const element = findEquipSlot(slot);
            if (!element) {
              missing.push(slot);
              continue;
            }
            if (slotItemName(element)) await unequipSlot(slot);
            if (!(await equipInto(slot, item))) {
              missing.push(`${slot}: ${item.name}`);
            }
          }
          for (const [slot, item] of wanted) {
            const label = `${slot}: ${item.name}`;
            if (!slotHolds(slot, item) && findEquipSlot(slot) && !missing.includes(label)) {
              missing.push(label);
            }
          }
          const signature = missing.join("|");
          if (!missing.length || signature === previous) break;
          previous = signature;
          await sleep(80);
        }
        if (missing.length) {
          await uiAlert(
            `Loaded “${build.name}”`,
            `Could not equip: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}.`,
          );
        } else {
          notify(`Loaded “${build.name}”.`);
        }
      } finally {
        equipBuildBusy = false;
      }
    });
    const saveEquipBuild = guardAsync("equipment", async () => {
      const slots = readEquippedBuild();
      if (!Object.keys(slots).length) {
        await uiAlert("Nothing equipped to save.", "");
        return;
      }
      const name = await uiPrompt("Equipment build name", `Set ${equipBuilds.length + 1}`);
      if (!name || !name.trim()) return;
      const clean = name.trim().slice(0, 60);
      const fresh = {
        id: `${Date.now()}-${shortId().slice(0, 5)}`,
        name: clean,
        slots,
        at: Date.now(),
      };
      const twin = equipBuilds.findIndex((build) => build.name === clean);
      if (twin >= 0) {
        const replace = await uiConfirm(
          `Replace “${clean}”?`,
          "A saved equipment build with this name already exists.",
          { okLabel: "Replace" },
        );
        if (!replace) return;
        fresh.id = equipBuilds[twin].id;
        equipBuilds[twin] = fresh;
      } else {
        equipBuilds.unshift(fresh);
      }
      writeEquipBuilds();
      setupEquipBuilds();
      notify(`Saved “${clean}”.`);
    });
    const deleteEquipBuild = guardAsync("equipment", async (id) => {
      const build = equipBuilds.find((entry) => entry.id === id);
      if (!build) return;
      const ok = await uiConfirm(`Delete “${build.name}”?`, "", {
        okLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      equipBuilds = equipBuilds.filter((entry) => entry.id !== id);
      writeEquipBuilds();
      setupEquipBuilds();
    });
    const unequipEverything = guardAsync("equipment", async () => {
      if (equipBuildBusy) {
        notify("Still changing equipment — one moment.");
        return;
      }
      if (!Object.keys(readEquippedBuild()).length) {
        await uiAlert("Nothing equipped.", "");
        return;
      }
      const ok = await uiConfirm("Unequip all equipment?", "", {
        okLabel: "Unequip all",
      });
      if (!ok || equipBuildBusy) return;
      equipBuildBusy = true;
      try {
        await unequipAllEquipment();
      } finally {
        equipBuildBusy = false;
      }
    });

    const onEquipBuildClick = (event) => {
      if (event.target.closest(".ro-equip-save")) {
        saveEquipBuild();
        return;
      }
      const load = event.target.closest(".ro-equip-load");
      if (load) {
        loadEquipBuild(load.dataset.id);
        return;
      }
      const remove = event.target.closest(".ro-equip-del");
      if (remove) {
        deleteEquipBuild(remove.dataset.id);
        return;
      }
      if (event.target.closest(".ro-equip-unequip")) unequipEverything();
    };
    const renderEquipBuildRow = (row) => {
      const list = row.querySelector(".ro-equip-list");
      if (!list) return;
      const signature = equipBuilds
        .map((build) => `${build.id}:${build.name}`)
        .join("|");
      if (list.dataset.signature === signature) return;
      list.dataset.signature = signature;
      list.innerHTML = setButtonsHtml("ro-equip", equipBuilds);
    };
    const setupEquipBuilds = () => {
      const panel = document.getElementById("charpanel");
      const tabrow = panel?.querySelector(".cp-tabrow");
      if (!tabrow) return;
      let row = document.getElementById("ro-equip-builds");
      if (!row) {
        row = document.createElement("div");
        row.id = "ro-equip-builds";
        row.className = "ro-equip-builds";
        row.innerHTML =
          '<button type="button" class="ro-btn small ro-equip-save" title="Save current equipment as a build">+</button><span class="ro-equip-list"></span><button type="button" class="ro-btn small ro-equip-unequip" title="Unequip all equipment">Unequip all</button>';
        row.addEventListener("click", onEquipBuildClick);
        tabrow.after(row);
      }
      const active = panel.querySelector(".tab-btn.active")?.dataset.tab || "";
      row.classList.toggle("hidden", active !== "equip");
      renderEquipBuildRow(row);
      panel.querySelectorAll(".tab-btn").forEach((button) => {
        if (button.dataset.roEquipTab) return;
        button.dataset.roEquipTab = "1";
        button.addEventListener("click", () =>
          setTimeout(guard("equipment", setupEquipBuilds), 0),
        );
      });
    };

    const refreshToolLists = () => {
      for (const list of $$(".ro-skill-list, .ro-equip-list")) {
        delete list.dataset.signature;
      }
      setupSkillBuilds();
      setupEquipBuilds();
    };

    // =====================================================================
    // 10. Start-up
    // =====================================================================
    const RUN_END_MS = 4000; // the HUD may blink away for a moment mid-run
    let runActive = false;
    let lastRunSeen = 0;

    const runVisible = () => {
      const hud = $("#hud");
      return (
        !!$("#stage canvas.ro-cursor") && !!hud && !hud.classList.contains("hidden")
      );
    };
    const resetRunState = () => {
      runPickValues.clear();
      runLearned.clear();
      pendingPick = null;
      endSession();
    };
    const watchRun = () => {
      if (runVisible()) {
        lastRunSeen = nowMs();
        if (runActive) return;
        runActive = true;
        cls = null;
        activeBuild = null;
        activeBuildClass = null;
        promptChoiceName = null;
        minimapZoomDone = false;
        releaseLootKeys();
        resetMovePath();
        resetRunState();
        runStats = emptyRunStats();
        syncClass();
        if (!activeBuild) {
          const job = cls || settingsClass;
          resolveActiveBuild(SKILLS[job] ? job : "swordsman");
        }
        logEvent("run", "Run started", { toast: false });
        queuePrompt();
        refreshUi();
      } else if (runActive && nowMs() - lastRunSeen > RUN_END_MS) {
        runActive = false;
        releaseLootKeys();
        resetMovePath();
        resetRunState();
        hidePrompt();
        logEvent("run", "Run ended", { toast: false });
        refreshUi();
      }
    };

    // ------------------------------------------------------------ hotkeys --
    const OWN_UI = `#${PANEL_ID}, #${PROMPT_ID}`;
    const onHotkey = (event) => {
      const key = event.key;
      if (key !== "F8" && key !== "F9" && key !== "Escape") return;
      const target = event.target;
      const inOwnUi =
        target instanceof Element && !!target.closest(OWN_UI);
      if (key === "Escape") {
        // Only our own panel, and only when it has the focus: Escape
        // belongs to the game everywhere else.
        if (!inOwnUi || !panelOpen() || dialogOpen()) return;
        if (isTypingTarget(target) || !target.closest(`#${PANEL_ID}`)) return;
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (!inOwnUi && isTypingTarget(target)) return;
      event.preventDefault();
      if (event.repeat || dialogOpen()) return;
      if (key === "F8") {
        setAutoMove(!autoMove);
        notify(`Auto-move ${autoMove ? "on" : "off"}`);
      } else {
        togglePanel();
      }
    };

    // ---------------------------------------------------------- scheduler --
    // One timer drives everything; each job keeps its own pace.
    const jobs = [
      { every: 200, run: guard("picker", tickPicker), next: 0 },
      { every: 100, run: guard("move", tickMove), next: 0 },
      { every: 250, run: guard("loot", tickPickup), next: 0 },
      { every: 700, run: guard("run", watchRun), next: 0 },
      { every: 1000, run: guard("inventory", setupInventoryFilters), next: 0 },
      { every: 1000, run: guard("talents", setupSkillBuilds), next: 0 },
      { every: 1000, run: guard("equipment", setupEquipBuilds), next: 0 },
      { every: 1000, run: guard("minimap-zoom", ensureMinimapZoom), next: 0 },
      { every: 1000, run: guard("customize", ensureCustomizeTriggers), next: 0 },
    ];
    const tick = () => {
      const t = nowMs();
      for (const job of jobs) {
        if (t < job.next) continue;
        job.next = t + job.every;
        job.run();
      }
    };

    // Settings changed in another tab of the game are picked up here.
    let storageTimer = 0;
    const onStorage = (event) => {
      if (event.key !== null && !DATA_KEYS.includes(event.key)) return;
      clearTimeout(storageTimer);
      storageTimer = setTimeout(
        guard("storage", () => {
          // Unsaved edits made here win; they are about to be written.
          if (pendingSaves.size || dialogOpen()) return;
          reloadState();
        }),
        400,
      );
    };

    const start = async () => {
      let restoredAt = 0;
      try {
        restoredAt = await restoreFromMirrorIfEmpty();
      } catch (error) {
        noteError("restore", error);
      }
      // Use the last known live registry before builds are normalised, so a
      // saved build is checked against the same tables it was written with.
      try {
        applyCachedGameData();
      } catch (error) {
        noteError("gamedata", error);
      }
      reloadState();
      // Store the builds in their current shape, as 1.x did on load.
      saveBuildData();
      ensureCustomizeTriggers();
      if (opts.keepActive) {
        applyKeepActive().catch((error) => noteError("auto-pause", error));
      }

      window.addEventListener("keydown", guard("hotkey", onHotkey), true);
      window.addEventListener("storage", guard("storage", onStorage));
      window.addEventListener("message", onGameDataMessage);
      window.addEventListener("pagehide", guard("save", flushSaves));
      document.addEventListener(
        "visibilitychange",
        guard("save", () => {
          if (document.visibilityState === "hidden") flushSaves();
        }),
      );
      bindManualInput();
      requestGameData();
      setTimeout(
        guard("gamedata", () => {
          if (gameDataSeen || gameDataInfo) return;
          logEvent(
            "info",
            "Live game data not found; using the built-in tables.",
            { toast: false },
          );
        }),
        12000,
      );

      tick();
      setInterval(tick, 100);

      if (restoredAt) {
        logEvent(
          "info",
          "Builds and settings were restored from the extension's safety copy.",
          { force: true },
        );
      }
    };

    start().then(undefined, (error) => noteError("start", error));
  }

  // On the game's own site start right away. Anywhere else the script is
  // allowed to run (a local copy of the game), wait until the page shows
  // the game's picker, so unrelated local pages are left untouched.
  const GAME_MARKS = "#picker, #lu-sockets, #stage canvas.ro-cursor, #drop-reveal";
  const launch = () => {
    if (root.dataset.roAutoPicker) return;
    root.dataset.roAutoPicker = "1";
    try {
      main();
    } catch {
      // Never let a start-up problem reach the page.
    }
  };
  const looksLikeGame = () => {
    try {
      return !!document.querySelector(GAME_MARKS);
    } catch {
      return false;
    }
  };
  if (OFFICIAL_HOST || looksLikeGame()) {
    launch();
  } else {
    let checks = 0;
    const wait = () => {
      if (root.dataset.roAutoPicker) return;
      if (looksLikeGame()) {
        launch();
        return;
      }
      checks += 1;
      setTimeout(wait, checks < 60 ? 1000 : 5000);
    };
    setTimeout(wait, 1000);
  }
})();
