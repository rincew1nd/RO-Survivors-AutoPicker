/*
 * RO Survivors Auto Picker - live game data loader (MAIN world).
 *
 * The game ships its whole content registry in the ES module chunk that the
 * page preloads as build/soul_linker-<hash>.js. That module is already in the
 * page's module cache, so importing it here costs no extra download:
 *
 *   g     skills    {id, name, icon, kind, type, tags, ...}
 *   f     job order {job: [skillId, ...]} for the first jobs
 *   cA    items     {id, slot, name, icon, ...} with text(value) lines
 *   J / c class defs (first jobs / advanced jobs)
 *   d     talents   keyed "job.branch.name", with mod.skill and mod.per
 *
 * Export names are minified and change every build, so everything below is
 * found by shape. The result is posted to the picker in the isolated world as
 * plain JSON; functions cannot cross postMessage, so any text is rendered
 * here first.
 */
(() => {
  "use strict";

  const MARK = "__roAutoGameData";
  const ACK = "__roAutoDataAck";
  const WANT = "__roAutoWantData";
  const VERSION = 2;
  const SCALING_STAT = { melee: "str", magic: "int", ranged: "dex" };
  const SAFE_SLOT = new Set([
    "potion",
    "elixir",
    "blessing",
    "deity",
    "dish",
  ]);
  const EFFECT_ALIAS = {
    poison: "dot",
    reduction: "damageReduction",
    haste: "cd",
    time: "duration",
  };

  const targetOrigin = () => {
    try {
      return location.origin && location.origin !== "null"
        ? location.origin
        : "*";
    } catch {
      return "*";
    }
  };
  const post = (data) => {
    try {
      window.postMessage(data, targetOrigin());
    } catch {}
  };

  // The module is listed as a preload before the game runs; later it is also
  // visible in the resource timing buffer.
  const soulLinkerUrl = () => {
    try {
      for (const link of document.querySelectorAll("link[href]")) {
        const href = link.href || "";
        if (/soul_linker-[^/]+\.js(?:\?|$)/.test(href)) return href;
      }
      const entries = performance.getEntriesByType("resource") || [];
      for (const entry of entries) {
        const name = entry.name || "";
        if (/\/build\/soul_linker-[^/]+\.js/.test(name)) return name;
      }
    } catch {}
    return null;
  };

  const isPlainObject = (value) =>
    !!value && typeof value === "object" && !Array.isArray(value);

  // One pass over the namespace: match registries by the keys and value shape
  // they must have. Nothing here depends on an export name.
  const pickRegistries = (ns) => {
    let skills = null;
    let items = null;
    let jobSkills = null;
    let talents = null;
    const classes = [];
    for (const value of Object.values(ns)) {
      if (Array.isArray(value)) {
        if (
          value.length >= 5 &&
          value.every(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.start === "string" &&
              "scaling" in entry,
          )
        ) {
          classes.push(value);
        }
        continue;
      }
      if (!isPlainObject(value)) continue;
      const keys = Object.keys(value);
      if (!skills && keys.includes("bash") && keys.includes("firebolt")) {
        const list = Object.values(value);
        if (
          list.length > 20 &&
          list.every(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.icon === "string" &&
              typeof entry.kind === "string",
          )
        ) {
          skills = value;
          continue;
        }
      }
      if (!items && keys.includes("p_dmg") && keys.includes("g_war")) {
        const list = Object.values(value);
        if (
          list.length > 10 &&
          list.every(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.slot === "string" &&
              typeof entry.name === "string",
          )
        ) {
          items = value;
          continue;
        }
      }
      if (
        !jobSkills &&
        keys.length >= 8 &&
        keys.length <= 12 &&
        keys.includes("swordsman") &&
        keys.includes("taekwon") &&
        Object.values(value).every(
          (list) =>
            Array.isArray(list) && list.every((id) => typeof id === "string"),
        )
      ) {
        jobSkills = value;
        continue;
      }
      if (
        !talents &&
        keys.length > 300 &&
        keys.some((key) => /^[a-z_]+\.[0-9]+\./.test(key))
      ) {
        talents = value;
      }
    }
    return { skills, items, jobSkills, talents, classes };
  };

  const itemLines = (entry) => {
    try {
      if (typeof entry.text !== "function") return [];
      return String(entry.text(0.2))
        .split(/\s*·\s*/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4);
    } catch {
      return [];
    }
  };

  const buildPayload = async () => {
    const url = soulLinkerUrl();
    if (!url) return null;
    let ns;
    try {
      ns = await import(url);
    } catch {
      return null;
    }
    const { skills, items, jobSkills, talents, classes } =
      pickRegistries(ns);
    if (!skills || !items || !jobSkills) return null;

    const skillAspects = (entry) => {
      if (typeof entry.create !== "function") {
        return { aspects: [], effects: [], countTarget: false, countUnit: "" };
      }
      try {
        const skill = entry.create();
        const unit =
          typeof skill.countUnit === "function" ? skill.countUnit() : "";
        const rawAspects = typeof skill.upgradeAspects === "function"
          ? skill.upgradeAspects()
          : [];
        const countTarget = unit === "objetivo" && rawAspects.includes("count");
        const aspects = rawAspects.map((key) =>
          unit === "objetivo" && key === "count" ? "targets" : key,
        );
        const effects = (Array.isArray(skill.effects) ? skill.effects : [])
          .map((effect) => effect && effect.key)
          .filter((key) => typeof key === "string")
          .map((key) => EFFECT_ALIAS[key] ?? key);
        if (effects.length) aspects.push(...effects, "effect");
        return {
          aspects: [...new Set(aspects)],
          effects: [...new Set(effects)],
          countTarget,
          countUnit: unit,
        };
      } catch {
        return { aspects: [], effects: [], countTarget: false, countUnit: "" };
      }
    };

    const skillList = Object.values(skills)
      .filter((entry) => typeof entry.id === "string" && entry.id)
      .map((entry) => {
        const { aspects, effects, countTarget, countUnit } =
          skillAspects(entry);
        return {
          id: entry.id,
          name: String(entry.name || entry.id).slice(0, 80),
          icon: typeof entry.icon === "string" ? entry.icon : "",
          kind: typeof entry.kind === "string" ? entry.kind : "",
          type: typeof entry.type === "string" ? entry.type : "",
          tags: Array.isArray(entry.tags)
            ? entry.tags.filter((tag) => typeof tag === "string").slice(0, 12)
            : [],
          aspects,
          effects,
          countTarget,
          countUnit,
        };
      });
    if (!skillList.length) return null;

    const known = new Set(skillList.map((entry) => entry.id));
    const jobs = {};
    for (const [job, list] of Object.entries(jobSkills)) {
      const ids = list.filter((id) => known.has(id));
      if (ids.length) jobs[job] = ids;
    }
    if (!Object.keys(jobs).length) return null;

    const itemList = Object.values(items)
      .filter(
        (entry) =>
          typeof entry.id === "string" &&
          SAFE_SLOT.has(entry.slot),
      )
      .map((entry) => ({
        id: entry.id,
        name: String(entry.name || entry.id).slice(0, 80),
        slot: entry.slot,
        icon: entry.icon != null ? String(entry.icon).slice(0, 24) : "",
        run:
          entry.slot === "potion" ||
          entry.slot === "elixir" ||
          entry.slot === "blessing"
            ? entry.id
            : "",
        lines: itemLines(entry),
      }));
    if (!itemList.length) return null;

    const classDefs = [];
    const seenClass = new Set();
    for (const list of classes) {
      for (const entry of list) {
        if (!entry || typeof entry.id !== "string") continue;
        const existing = seenClass.has(entry.id)
          ? classDefs.find((item) => item.id === entry.id)
          : null;
        if (existing) {
          if (entry.base && !existing.base) existing.base = entry.base;
          continue;
        }
        seenClass.add(entry.id);
        classDefs.push({
          id: entry.id,
          name: String(entry.name || entry.id).slice(0, 60),
          base: typeof entry.base === "string" ? entry.base : "",
          start: typeof entry.start === "string" ? entry.start : "",
          scaling: typeof entry.scaling === "string" ? entry.scaling : "",
          tier: typeof entry.tier === "string" ? entry.tier : "",
        });
      }
    }
    const mainStat = {};
    for (const entry of classDefs) {
      const stat = SCALING_STAT[entry.scaling];
      if (stat) mainStat[entry.id] = stat;
    }

    const fileName = url.split("/").pop() || "soul_linker";
    const talentCount = talents ? Object.keys(talents).length : 0;
    return {
      v: VERSION,
      signature: `${fileName}|${skillList.length}|${itemList.length}|${classDefs.length}|${talentCount}`,
      skills: skillList,
      jobs,
      items: itemList,
      classes: classDefs,
      mainStat,
      counts: {
        skills: skillList.length,
        items: itemList.length,
        classes: classDefs.filter((entry) => !entry.base).length,
        talents: talentCount,
      },
    };
  };

  let payloadPromise = null;
  let delivered = false;
  const deliver = () => {
    if (delivered) return;
    if (!payloadPromise) payloadPromise = buildPayload();
    payloadPromise
      .then((payload) => {
        if (!payload) {
          // The chunk may not be listed yet; let the next retry rebuild.
          if (!delivered) payloadPromise = null;
          return;
        }
        if (delivered) return;
        post({ [MARK]: VERSION, payload });
      })
      .catch(() => {
        // A failed attempt may be a chunk that is not ready yet; allow a retry.
        if (!delivered) payloadPromise = null;
      });
  };

  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data[ACK] === 1) {
        delivered = true;
        return;
      }
      if (event.data[WANT] === 1) deliver();
    },
    true,
  );

  deliver();
  let tries = 0;
  const timer = setInterval(() => {
    if (delivered || ++tries > 10) {
      clearInterval(timer);
      return;
    }
    deliver();
  }, 1500);
})();
