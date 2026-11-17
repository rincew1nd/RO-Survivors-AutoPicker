RO Survivors Auto Picker 4.2.0
==============================

Install or update
  1. Unzip into a folder. Unzipping over 1.0.0 or any 2.x folder is fine.
  2. Chrome/Edge: open chrome://extensions, turn on "Developer mode",
     choose "Load unpacked" and pick the folder. If an older version is
     already listed, press its reload button instead.
  3. Reload the game tab.

Everything saved by 1.0.0 (builds, loot rules, talent and equipment sets,
on/off switches) is kept and used as it is.

Run it in its own profile
  play-ro.cmd (Windows) and play-ro.sh (Linux) start the cloakbrowser
  build with its own profile folder (.cloak-profile on Windows,
  .cloak-profile-linux on Linux, so the two never share a Chrome
  profile), the addon loaded from src and the game URL. CloakBrowser is
  required: install it once with "npx -y cloakbrowser install" (a free
  license key is needed). The normal browser profile is not touched.
  If CloakBrowser is already running, launching again only opens another
  window in that process and the old extension stays loaded. After an
  update, quit every CloakBrowser window (check Task Manager) and start it
  again; the Activity log must say "Input worker 4.2.0 ready."

Keys
  F8   auto-move on / off
  F9   open / close the settings panel (or click the gear on the map
       title, or Customize in the Options menu)

Game input is sent through the debugger
  Movement keys and card picks are replayed through the browser's own
  input pipeline (the "debugger" permission), so the page sees them as
  hardware input with isTrusted set. Rerolls, banishes, focus, loot rolls
  and the minimap zoom run the game's own button handler through the
  debugger too, because input events do not reach a background window.
  Click-based auto-move uses a trusted mouse click while the tab is
  active and the game's keys in the background. Chrome and Edge show a
  "started debugging this browser" bar on the game tab while it is open.
  Synthetic key and pointer events are never used; a button that does not
  expose an onclick handler is activated with the DOM's own click(). Where
  the debugger is not available - a browser without the debugger API, or
  DevTools already open on the tab - the addon does not press keys
  or click the game at all: WASD movement, card picks, loot rolls and
  click-based auto-move stay idle. It keeps retrying, so they start working again once
  the debugger is free (DevTools closed). The state is written to the log
  once per page load, and again if it changes.

What changed in 4.2.0
  - The input worker now logs its build, every message and every debugger
    call (ok, failed, timed out) to the service worker console. Its last
    message and call are readable there as __roaInput while an action is
    stuck.
  - Every debugger call has a timeout, so a call that never answers is
    reported in the Activity tab instead of leaving the action with no reply
    ("message port closed").
  - Sends that fail with "message port closed" are retried once, and the
    Activity tab shows which worker build answered, so an old worker is
    easy to spot.
  - A worker build check runs on page load. When an old worker is still
    loaded, the addon warns to fully quit CloakBrowser (a running browser
    ignores a new --load-extension flag and keeps the previous worker).

What changed in 4.1.1
  - Fixed: one failed debugger action could disable every later key press and
    click for the rest of the page load. The debugger is now detached before
    the next action tries to attach again.
  - Fixed: the minimap zoom could fail and never retry, so the map stayed at
    its default size. The two zoom clicks are now sent one after the other
    and retried until they land.
  - Buttons that do not expose an onclick handler are now activated with the
    DOM's own click(), so more game buttons work.
  - When the debugger is unavailable, the Activity tab now shows the reason
    (for example another debugger or DevTools attached to the tab).

What changed in 4.1.0
  - Gameplay actions no longer use synthetic clicks. Card picks use the
    picker's trusted number keys. Rerolls, banishes, focus, loot rolls and
    the minimap zoom invoke the game's own button handler through the
    debugger, so they also work while the game window is in the background.
    Click-based auto-move uses a trusted mouse click while the tab is
    active and the game's keys in the background. Where that is
    impossible the action is simply not sent.
  - Game actions need the same "debugger" permission as the keys.

What changed in 4.0.0
  - Movement keys are no longer synthetic. They are replayed through the
    browser's own input pipeline with the debugger API, so the game sees
    real key presses (isTrusted true). No key event is faked any more;
    where that is impossible the keys are simply not pressed.
  - Chrome and Edge need the new "debugger" permission. The launch
    scripts hide the debugging bar with --silent-debugger-extension-api.
  - A key release that could not be delivered is retried, so a stuck key
    can no longer keep the hero walking.
  - New launchers for Linux and Windows (play-ro.sh, play-ro.cmd) that
    use their own profile and load the addon from src.

What changed in 3.0.1
  - The game now builds its Options window on demand. The addon opens it
    once to switch off auto-pause again, then closes it.
  - "Disable game auto-pause" works again, so runs keep going when you
    switch tab or app.

What changed in 3.0.0
  - The settings panel now looks like the game's own windows.
  - Settings open from a gear on the map title or from a Customize
    button in the game's Options menu. Either shortcut can be turned off
    on General > Interface.
  - The floating gear button is gone.
  - Auto-move follows the coordinates in the minimap title instead of
    screen offsets. Circle, Random and Back and forth use the step length
    set in the Movement tab, in map coordinates.
  - Chests and magnets still pull the hero off the path, but after the
    loot is collected it walks back to the exact coordinate where it left
    the path and carries on from there.
  - If the hero cannot get closer to its target for three seconds, the
    pattern restarts from where it stands and turns around to get unstuck.
  - Movement: "Pick up dropped items" walks to loot and cards on the
    minimap, filtered by "Item rarity and higher" (Uncommon to Legendary).
  - Ground loot now aims a little below the icon, so the hero stops on the
    game's pickup point instead of circling a chest.
  - Inventory, sell and trade filters can also show only one item tier.
  - New Cards tab: every card's picture, stats, slot and drop source,
    with search, slot and stat filters.
  - Figure-8 is gone. A saved Figure-8 setting falls back to Circle.

What changed in 2.5.0
  - New Rerolls section in the build editor: every reroll rule now sits
    together with the build it affects, instead of being split between the
    old Skill rerolls and Item rerolls sections. Each build keeps its own
    reroll budget and skill, item and mandatory-group reroll switches.
  - "Pick a random upgrade when rerolls run out" stays on General, because
    it applies to every build.
  - Tabs, list rows, section headings and checkboxes now share one style.

What changed in 2.4.0
  - Skill upgrade options and effect upgrades now come from every active
    skill in the game, including advanced-job skills learned from cards.
  - Limit validation uses the skill tooltip summary totals, so Endless
    Tower bonuses and other modifiers that are not listed in the skill's
    upgrade history are counted.
  - New Movement option: "Move with WASD instead of clicking". It uses the
    same path, step length and pace, but holds the game's movement keys.

What changed in 2.3.0
  - Skills, items and their upgrade options now come from the game's own
    data module instead of only the built-in list. New skills, items and
    classes the game adds are picked up on the next page load, with no
    addon update.
  - The built-in tables are still used as a fallback when the game's data
    cannot be read, and detected cards are still remembered as before.
  - Data tab shows how many skills, items and classes were loaded from the
    game.

What changed in 2.2.5
  - All base-job skill tables now match the game order and the real skill
    aspects. This fixes misleading upgrade lists on other jobs, for example
    Heal, Cart Rush, Vending, Retreat, Double Strafe and the kicks.
  - Removed effect upgrades from Crazy Uproar and Enlarge Weight Limit;
    they do not have them.

What changed in 2.2.4
  - Mage skill table fixed: Lightning Bolt is back, the skills are in the
    game order, and the Spanish names match the game.
  - Mage upgrade options follow the real skill aspects: Frost Diver only
    offers cooldown and its freeze effect; Cold Bolt also gets its unique
    effect; the other mage skills no longer offer effects they do not have.

What changed in 2.2.3
  - Ground-loot steering no longer clicks screen points. It reads the
    minimap and holds the game movement keys (WASD) until the chest or
    magnet disappears. The orthographic camera angle no longer makes the
    hero orbit the target.
  - Those keys are released when the picker, a game window, the settings
    panel or the keyboard/chat takes over, and at the end of a run.

What changed in 2.2.2
  - At the start of a run the addon clicks the minimap zoom-in button
    (`.mm-zoom > button:nth-child(2)`) twice so the chest and magnet
    icons are larger for ground-loot detection.

What changed in 2.2.1
  - Ground loot moves the hero even when auto-move is switched off.
  - Movement also waits for any open game window (character sheet,
    options, pause, etc.), not just the card picker.
  - If the minimap is hidden or the browser will not let the addon read
    it, the Activity tab now explains why no chest/magnet was found.

What changed in 2.2.0
  - New Movement tab. Auto-move, its options and ground-loot collection
    live there.
  - Movement pauses while a level-up/chest picker or an addon dialog is
    open.
  - Ground loot: reads the treasure chest and magnet icons on the minimap
    and walks to the nearest one. Chests are skipped when you cannot
    afford the opening cost. Both have their own checkbox; both start on.
  - General: "Pick a random upgrade when rerolls run out" — only when no
    priority card is available, and only once the reroll budget is spent.

What changed in 2.1.0
  - Upgrade limits are hard caps: a limit of 250 now skips a +440% upgrade
    instead of allowing one oversized pick to pass it.
  - General tab: "Disable game auto-pause" (on by default) turns off the
    game's Options → Game → Auto-pause setting so the run keeps going when
    the tab or app loses focus.
  - Activity and skipped-step details survive a page reload (per tab).

What changed since 1.0.0
  Picking
  - Reroll limits are counted per offer. Before, offers that looked alike
    shared one budget, so rerolls could stop for the rest of a run.
  - "Reroll if no skill" stops once every required skill is learned, so
    rerolls are no longer spent on offers that cannot contain one.
  - A card that was just picked is not clicked again while it is still on
    screen, and limits count each card once.
  - The class is worked out from the skills on offer and the skills already
    learned, not only from the HUD text.
  - Upgrade text is read more precisely: "projectile speed" is no longer
    taken for an extra projectile, "critical damage" for critical chance,
    "cast speed" for movement speed. "Damage over time" is recognised.
  - Rerolls per offer can be set per build (default 3, as before).

  New
  - Suggest only: highlights the best card and leaves the click to you.
  - Activity tab: what was picked, rerolled or rolled, and why.
  - Short on-screen note for each action (can be turned off).
  - Skills and items the built-in list does not know are remembered when
    they show up, and can then be added to a build.
  - Builds: duplicate, reorder, rename in place, copy as text / paste,
    restore the stock builds. Rows can be dragged between item groups.
  - Loot rules: quality and action can be set while adding; "*" as the
    name means "any item of this quality or better".
  - Auto-move: path, step length and pace; pauses for a few seconds when
    you move the hero yourself; optional "only during a run".
  - Backup tab: export / import everything, undo, reset. A safety copy is
    kept by the extension and restored if the site's data is cleared.
  - The settings open from a gear on the map title or a button in the
    game's Options menu; either can be turned off on the General tab.
  - Optional sound when a card is left for you to choose.

  Sturdier
  - No browser alert / confirm / prompt boxes any more (they freeze the
    game); the addon shows its own small dialogs.
  - F8 / F9 also work while the settings panel has the focus.
  - Talent and equipment sets wait for the game to react and check the
    result instead of relying on fixed pauses. Loading an equipment set
    leaves slots alone that already hold the right item.
  - The inventory search only un-hides what it hid itself.
  - Damaged saved data no longer stops the addon; it is set aside.
  - On localhost / file pages the addon stays out unless the page is the
    game.

Files
  manifest.json   extension manifest
  data.js         game tables: skills, items, stock builds (fallback seed)
  gamedata.js     reads the live game data module and hands it to autopick.js
  autopick.js     the addon
  autopick.css    its styles
  icons/          extension icons
