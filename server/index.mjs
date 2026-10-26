// Video Octopus: local server. Binds to 127.0.0.1 only and refuses requests from other web pages.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync, watch, renameSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, relative, basename, dirname, sep } from 'node:path';
import { createSceneSandbox, sandboxOrigin } from './generated-sandbox.mjs';
import { settings, saveSettings, inside, readJSON, writeJSON, readJSONBody, renameFolder, processExited, expandHome, reveal, state, patchState, setProjectState, mtime, APP_DIR, LOCAL_DIR } from './util.mjs';
import { claudeInfo, ChatSession, forReplay } from './claude.mjs';
import { makeChat, staleChat, foreignSession, enginesView, modelSourceView, engineName, agentStatus, ENGINES } from './engines.mjs';
import { listProjects, createProject, projectDir, projectMeta, saveProjectMeta, listTakes, importTake, importTakeFrom, makeProxies,
  pipelineStatus, stepPrompt, formats, listSkills, roles, sources, projectsRoot, probe, probeFile, formatId, formatInfo, isAudio, isTakeFile,
  importUpload, lockedCut, appendWorklog, setSkipped, takeDuration, setProjectIdCheck, markAlreadyEdited, cleanUpAnyway } from './studio.mjs';
import { openCutEditor, cutPlan, cutEditorRoute, closeAll } from './cuteditor.mjs';
import { onProjectFiles, syncCutItem, retimeOnSave, syncDocItems, markPackageBase, cutTake, saveCut } from './cutsync.mjs';
import { cutReviewRoute, markEdits, cutReadOnly, LOCKED_ERROR } from './cutreview.mjs';
import { autoFrame } from './autoframe.mjs';
import { exportInfo, startExport, cancelExport, stopAllExports, canvasSources, exportsBusy } from './export.mjs';
import { layersRoute, cancelLayers, stopAllLayers, layersRunning, listLayerExports, layersBusy } from './export-layers.mjs';
import { audioRoute, cancelAudio, stopAllAudio, audioRunning, audioBusy } from './export-audio.mjs';
import { textRoute, listTextExports } from './export-text.mjs';
import { normalize, defaultLayout, newLayers } from '../web/layout.js';
import { thumbFor } from './thumbs.mjs';
import { timelineData, filePeaks, joinFlags } from './timeline.mjs';
import { layoutsRoute } from './saved-layouts.mjs';
import { scenesView, scenesSummary, notesOp, setOverride, applyBrief, kitBrief, updateKit, KIT, approvePlan, unapprovePlan, packageResult, packageRunView } from './scenes.mjs';
import { buildSteps, renderKind } from './built.mjs';
import { appRoute } from './setup.mjs';
import { onboardingRoute, ffmpegReady, setupBusy } from './onboarding.mjs';
import { createStudio, defaultStudioPath } from './starter.mjs';
import { profileRoute, profileBusy, killProfileResearch, createConfiguredProject, pinnedContext, profilePalette, projectIdHasRows, hasPinnedContext, channelSummaries, studioWaiting, withProjectChannels, newVideoChoice, rememberNewVideo, selectProjectContext, simpleVideoChoice, rememberSimpleVideo, lastSimpleVideo, switchProjectShape } from './profiles.mjs';
import { UNTITLED, autoName, nameFromReply, namingContext, onAutoRename } from './naming.mjs';
import { memoryRoute } from './memory.mjs';
import { packagingRoute, resourcesRoute, packagingBusy, killPackaging } from './packaging.mjs';
import { startBuildRun, endBuildRun, buildProgress, noteBuildFiles } from './build-progress.mjs';
import { learningRoute, learningProjectContext, projectLearning, guardLearnedStep, learningBusy, killLearning, approveLearnedPlan, unapproveLearnedPlan } from './learning.mjs';
import { assistantRoute, killAssistant, assistantBusy } from './assistant.mjs';
import { onSettingsChange, restartWhenIdle, section, transcribeHow } from './settings.mjs';
import { listBackgrounds, useLibraryBackground, saveUpload, saveToLibrary, generateBrief, libraryFile, bgJobRoute, backgroundsBusy } from './backgrounds.mjs';
import { kitRoute, libraryRoute, kitContext, kitSummary, KIT_ACTIONS } from './kit.mjs';
import { saveToLibrary as addToLibrary } from './library.mjs';
import { blocksRoute, blocksSummary, blocksContext, prepareState, stepBrief, noteStep, receiveBlockTake, blocksView, setServerWriteHook } from './blocks.mjs';
import { makePackageOwner, UI_ROUTES } from './package-owner.mjs';
import { shotsRoute, readShotsAndZooms, shotsContext, onShotNotes } from './shots.mjs';
import { recRoute, unfinishedTakes, recorderChoices, recorderBusy } from './browser-recorder.mjs';
import { mediaRoute, importedRecordings } from './media.mjs';
import { playSource, playbackView, playbackMode, PLAYBACK_MODES, copiesSummary, deleteCopies, allCopies, deleteAllCopies } from './playback.mjs';
import { trashRoute, binEntry } from './trash.mjs';
import { simpleResourcesRoute, resourcesForNewVideo } from './simple-resources.mjs';
import { agentChoice, setAgentChoice, choiceView, codexModels } from './agent-choices.mjs';
import { ccSource } from './claude-source.mjs';
import { codexSource } from './codex.mjs';
import { piModels } from './pi.mjs';
import { binName } from './os-trash.mjs';
import { logUse, usageFromFiles, cutSaved, dashboard, backfill, catchUpUsage, getPlanUsage } from './usage.mjs';
import { schedulesRoute, startScheduler, stopScheduler, readSchedules, schedulesBusy } from './schedules.mjs';
import { inboxRoute, inboxItems } from './inbox.mjs';
import { updatesRoute, startUpdateChecks, updateCount, RESTART_CODE, activateStudioSkills, managedSkillsView } from './updates.mjs';
import { trackTurns, unfinishedOf, clearUnfinished, undoTurn, keepInTurn } from './turns.mjs';
import { downloadsBusy } from './hfmodels.mjs';
import { setActivityProbe, beginWrite, assertNotUpdating } from './maintenance.mjs';

const PORT = Number(process.env.PORT || settings().port || 4800);
const WEB = join(APP_DIR, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.md': 'text/plain; charset=utf-8',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac' };

// ---- per-project chat sessions and event streams ----
const chats = new Map();
setActivityProbe(() => [
  ([...chats.values()].some((c) => c.busy) || assistantBusy() || learningBusy() || profileBusy() || packagingBusy()) && 'An agent is working or awaiting your reply.',
  schedulesBusy() && 'A scheduled run is running or queued.',
  (exportsBusy() || layersBusy() || audioBusy() || backgroundsBusy()) && 'An export or render is running.',
  recorderBusy() && 'Save or dismiss unfinished recordings first.',
  (setupBusy() || downloadsBusy()) && 'An installation or model download is running.',
].filter(Boolean));
const streams = new Map(); // project id -> Set(res)
// An archived project keeps its id with everything saved under it: its chat state and log, and its database rows.
setProjectIdCheck((id) => Boolean(state().projects[id]) || existsSync(join(LOCAL_DIR, 'chats', `${id}.jsonl`)) || projectIdHasRows(id));
const watchers = new Map();
// Which ways of trimming at a cut are on, for the usage log (Settings → Editing: A always, B and C optional).
const trimModes = () => { const e = section('editing'); return ['A', e.trimHighlight && 'B', e.trimLens && 'C'].filter(Boolean).join('+'); };
// Whose change a write is (server/package-owner.mjs): the window's routes stamp the project, Claude's turns and Video
// Octopus's own settles don't go into the change package (B1).
const owner = makePackageOwner({
  busy: (id) => Boolean(chats.get(id)?.busy),
  note: (id, n) => broadcast(id, { t: 'note', text: `Added to the change package: ${n.text}` }),
  settle: (dir) => blocksView(dir), // reading the row places rule blocks (a server write, wrapped below)
});
setServerWriteHook((dir, write) => { const id = basename(dir); return projectDir(id) === dir ? owner.serverWrite(id, dir, write) : write(); });
// The step whose brief went to a project's chat last, while that chat is still busy with it (the dock says it's
// running; Clean up has its own state with its sub-steps, blocks.mjs prepareState).
const stepRuns = new Map(); // project id -> { step, at }
const OPTIONAL_KIT_READS = new Set(['work/overrides.json', 'work/production.json']);

// Settings, keys or the profile changed: each chat picks them up when it next starts (once it's idle).
// Appearance is only how the app looks, and Updates only the app's own update check, so the chats carry on.
onSettingsChange((what) => { if (['appearance', 'updates', 'help', 'storage'].includes(what)) return; for (const c of chats.values()) restartWhenIdle(c); });
onSettingsChange((what) => { if (what === 'folders') activateStudioSkills(); });

// The project's chat, for a POST (a message, a step, the sessions list, an answer): made on first use, and after an
// agent switch in Settings the old conversation goes to earlier sessions here. GET routes use peekChat instead.
function chatFor(id) {
  let switched = false;
  if (staleChat(chats.get(id))) { chats.get(id).kill(); chats.delete(id); switched = true; }
  if (!chats.has(id)) {
    const chat = makeChat(id, () => projectContext(id));
    // A project with a pinned setup (every project made since channel profiles) runs in its own folder on every agent,
    // with its pinned skills passed in. A legacy project's Claude Code or Codex chat runs in the studio folder, where they
    // find its skills and notes; pi always runs in the project's folder (weaker models write "work/x.json" relative to it).
    // projectContext() tells the agent which of the two it is.
    chat.memoryBinding = { project: id };
    chat.projectScope = () => pinnedContext(id, projectDir(id));
    chat.cwd = () => (chat.projectScope() || chat.engine === 'pi') ? projectDir(id) || settings().studio : settings().studio;
    // Auto mode: a change outside this project's folder asks first (server/outside-hook.mjs; Claude Code only).
    chat.guard = () => projectDir(id);
    // The chat panel's Model and Effort for this video (server/agent-choices.mjs), over the studio default.
    chat.agentChoice = () => agentChoice(id, chat.engine);
    chat.listeners.add((ev) => broadcast(id, ev));
    chat.listeners.add((ev) => { if (ev.t === 'busy' && !ev.busy) { stepRuns.delete(id); endBuildRun(id); } });
    // Save changes → Claude (B6): when the turn after the Save ends, count what came of the items it sent, for the
    // Scenes panel and one line in the chat ("Claude finished · 2 notes done, 1 still open").
    chat.listeners.add((ev) => {
      if (ev.t !== 'busy' || ev.replay) return;
      const run = state().projects?.[id]?.packageRun;
      if (!run || run.result) return;
      if (ev.busy) { if (!run.started) setProjectState(id, { packageRun: { ...run, started: true } }); return; }
      if (!run.started) return;
      const dir = projectDir(id);
      if (!dir) return;
      try {
        const result = packageResult(dir, run.ids);
        setProjectState(id, { packageRun: { ...run, result: { ...result, at: Date.now() } } });
        logEvent(id, { t: 'note', text: `${result.text}.`, packageResult: true });
        broadcast(id, { t: 'files' });
      } catch (e) { console.error('package result:', e.message); }
    });
    // A turn ended: everything Claude wrote (and the blocks settled after it) is the package's new starting point (B1).
    chat.listeners.add((ev) => {
      if (ev.t !== 'busy' || ev.busy || ev.replay) return;
      const dir = projectDir(id);
      if (dir) try { owner.afterTurn(id, dir); } catch (e) { console.error('package after the turn:', e.message); }
    });
    // AI naming (server/naming.mjs): only the agent's own reply can name an automatically named video.
    chat.listeners.add((ev) => {
      if (ev.t !== 'text' || ev.replay) return;
      const name = nameFromReply(ev.text);
      if (name) autoName(id, name, 'agent');
    });
    // When a turn ends: did its step get its result (else the dock says "Didn't finish"), and what can Undo put back.
    trackTurns(id, chat, { broadcast: (ev) => broadcast(id, ev) });
    chats.set(id, chat);
    // The engine (or Claude Code's model source) changed in Settings: the conversation so far goes to "earlier
    // sessions" (it belongs to the other agent or model), and this one starts fresh; the project's files and notes carry over.
    const st = state().projects[id] || {};
    if (switched || foreignSession(st, chat.engine)) { try { chat.newSession(); } catch {} }
  }
  return chats.get(id);
}
// An automatic name was applied (the agent's block, or the Packaging working title): the open pages show it at once.
onAutoRename((id, name, by) => {
  keepInTurn(id, 'project.json', { name, autoNamedBy: by }); // not the agent's file change: no Undo for it
  broadcast(id, { t: 'renamed', name, by, ts: Date.now() });
});

// A look at the chat for a GET (the project view, the event stream): the one in use, or one made just to read the
// saved log. It's never kept, so nothing is renamed, written or logged until a POST calls chatFor.
const peekChat = (id) => chats.get(id) || makeChat(id, () => projectContext(id));

function projectContext(id) {
  const s = settings();
  const dir = projectDir(id);
  const meta = (dir && projectMeta(dir)) || {};
  const fmt = formats()[formatId(meta.type)] || 'not set';
  const src = dir ? roles(dir).take.map((f) => `source/${f}`).join(', ') : '';
  return [
    `You are the chat panel inside Video Octopus, the creator's local video editing app. Everything you do is for one project.`,
    // The same choice as chatFor's chat.cwd: the project's folder when it has a pinned setup, or for pi.
    dir && (engineName() === 'pi' || hasPinnedContext(id))
      ? `Your working directory is this project's folder, ${dir}: write project files by their path inside it (work/blocks.json, project.json). The studio folder is ${s.studio}.`
      : `Your working directory is the studio folder, ${s.studio}.`,
    `Project folder: ${dir ? relative(s.studio, dir).split(sep).join('/') : id} (inside the studio; type: ${fmt})${src ? `; source files: ${src}` : ''}.`,
    `Recorder takes have a screen file and a webcam file that start together and carry the same microphone audio. A take can also be camera only (just <stamp>_webcam.mp4 from Video Octopus's recorder, or _webcam.mov in an older take, with the mic) or mic only (just <stamp>_audio.wav, 24-bit PCM, no picture: the canvas and the export show the layout's background under its sound; it can also be a block's file, e.g. a voiceover sponsor read).`,
    `Work inside the project folder: source/ for originals (never change them), work/ for intermediate files, renders/ for videos, WORKLOG.md for the log.`,
    `Don't write outside this project's folder (other projects, the studio's library, memory, notes and logs, anything else), except a file the studio's own instructions (its CLAUDE.md, AGENTS.md, skills) tell you to write; when you do, say so in your reply: which file, and why. In Auto mode Video Octopus asks the creator before a change outside the project anyway. Temporary files are fine anywhere temporary.`,
    `Clocks: when you tell the creator a time, give it on the video as it plays: the cut's time (the locked cut's, else the rough cut's when there's no locked cut yet), as m:ss.s, the clock the Cut tab, Scenes, the renders and the canvas's "Play the locked cut" show. The take's own seconds (the words' and blocks' times, the cut files' segments) are for files only; if you ever have to name one, say "take 0:53.3" and give the cut time too. Cut time of take second t = the lengths of the kept segments before it, plus t minus the start of the segment it's in (segments_sec of work/edl_manual.json, else work/edl_fixed.json). Times in the production sheet, notes and renders are already on the cut's timeline.`,
    `The app shows the project's files live: when a skill writes work/tr/words.json, work/rough_map.json, work/joins.json or work/edl_manual.json, the Cut tab and the step buttons update on their own, so don't start your own servers or review pages for cutting (the Cut Editor is built into the Cut tab); tell the creator to open the Cut tab instead.`,
    `The canvas layout is "layout" in project.json, and you may edit it (the canvas follows): aspect "16:9"|"9:16"; preset "screen"|"camera"|"pip"|"split"|"boxed" (boxed = a screen card on two thirds and a tall camera card on the right third); side "right"|"left"; mirror "auto"|true|false; webcam {x,y,w} = the picture-in-picture box (top-left and width as fractions of the frame); pad 0-12 = PiP only, the screen as an inset card this % of the frame width from the edges; cam {shape "square"|"rounded"|"circle"|"frame", zoom 1-4 (1 = the whole camera height, 2 = twice as close), focus {x,y} = point of the camera picture the crop centres on, border "none"|"subtle"|"white"|"accent", borderW (export pixels), shadow true|false} = the camera framing and card edge in every layout; bg {kind "night"|"stars"|"led"|"image"|"video"|"code", file "assets/…" for image/video/code, name} = what shows behind the cards (stars and led are animated night backgrounds: drifting stars, an LED wave; code = an ES module export default {name, draw(g, W, H, t)}, a pure function of time); layers [{id, file (in source/), kind "cam"|"screen", x, y, w, shape, zoom, focus, border, borderW, shadow, audio, hidden}] = extra videos from other takes on top, from 0:00; hidden ["cam"|"screen"] = the canvas take's camera or screen left out of the picture and the export (a layer has its own hidden: true).`,
    `The app's Export button renders the canvas with ffmpeg into renders/<project>_<layout>_vN.mp4 on the locked cut, and puts a built block's render in for that block (your newest renders/*intro*.mp4 for the intro, on the production sheet's timeline; the creator can pick the canvas instead): its picture only, the export's own voice and sfx.json cues under it (so keep the cues for your render's transitions in work/sfx.json); each export leaves work/export/<time>/ with job.json and run.sh, which re-renders it. project.json finalRender is the render the creator marked Final on the Renders tab. The creator records with the Record button; the take lands in source/ by itself.`,
    `Export → Layers writes renders/<project>_layers_vN/: every layer as its own file from 0:00 (background, screen and camera cards, the scene's graphics layers or elements, the presenter cut-out, voice.wav, sound-cues.wav), README.txt with the stacking order, layers.json, motion.json (every Octopus.el element's times, boxes and painted bounds over time, and its element.keys from overrides.json) and FCPXML / FCP 7 XML timeline files. Export → Timeline file writes the same XML straight from the sources into renders/<project>_timeline_vN/.`,
    `Export → Audio, Transcript and Subtitles work on the final timeline (locked cut, blocks in order, sponsor-read files included): Audio writes renders/<project>_mix_vN.wav|m4a|mp3 (voice + sound cues, mixed like the video; _voice_vN = voice only; optional −14/−16 LUFS), Transcript renders/<project>_transcript_vN.txt|md (block headings, optional timecodes), Subtitles renders/<project>_subtitles_vN.srt|vtt, from work/words_refined.json, else work/tr/words.json (a file block's own words: work/tr/<file name>/words.json); the Video export can burn the captions in.`,
    `The scene plan waits for the creator: after Plan the scenes, they read it in the Plan stage and press Approve plan (Video Octopus then writes "approved" into work/production.json; never write or change that key yourself), or Ask for changes, which reaches you as "Changes to the scene plan: …": change the plan only, tell them what changed and stop. Build steps come after the approval.`,
    `Scenes: work/production.json is the production sheet. Video Octopus shows its scenes as blocks on the timeline and in its Scenes tab, where each scene plays from the newest render in renders/ (the canvas exports above don't count). Keep the scene times on the locked cut's timeline, the same timeline the renders are on, and give each new render the next version number (…_v4.mp4).`,
    `Review notes: the creator leaves notes per scene and pins them on the picture in the Scenes tab. They are in work/notes.json {notes: [{id, scene, block, text, t (seconds on the render timeline), pos {x, y} (fractions of the frame, when pinned), el {id, label} (the scene element under the pin), version, status, reply}], approved: {scene id: time}}. "Apply my notes" sends you the open ones. When you've handled a note, set its status to "done" and its reply to one line on what you changed (or status "question" with your question in reply). Never delete notes. When your turn after "Save changes → Claude" ends, Video Octopus counts the items it sent and tells the creator ("Claude finished · 2 notes done, 1 still open"); an item you leave as "sent" shows as "not marked done".`,
    `The change package: besides notes, the creator's quick edits in the Scenes tab are notes of kind "change" in the same file: {kind: "change", scene, field: "layout"|"background"|"transition"|"sfx"|"timing"|"style"|"text"|"cut", target {id, label} (a scene element, when it's about one), from, to, text}. Timing changes move a scene edge ({start, end}) or when an element is on screen ({in, out}); they never cut audio (the cut belongs to the Cut tab). A "cut" change (no scene) comes from the Cut tab: from and to are the kept parts of the take before and after ({segments: [[start, end], …]} in take seconds); the brief lists every edit with where it sits on the old cut and writes the old cut to work/cut_before_<id>.json, and before re-rendering you re-align everything that sits on the old timeline (production sheet times, scene files, keyframes and element times in work/overrides.json, note times, B-roll) so nothing drifts off its words. The creator sends the package with "Save changes → Claude". Every note and change with status "open", plus moves in work/overrides.json newer than the newest render, is the creator's change package. Video Octopus sends it to you as one message; if the creator asks you in this chat to send, apply or do "the package" or "my changes", read work/notes.json, tell them what's in it (how many items, which scenes), set those items to "sent", do them in one pass and re-render once, then mark each "done" with a one-line reply. If they ask what's waiting, read the open items and list them.`,
    `Direct edits: the creator can drag and resize the titles, cards and boxes of an HTML scene in Video Octopus. The moves are in work/overrides.json {v: 1, scenes: {"<scene id>" or "*" (every scene): {"<element id>": {dx, dy (frame pixels), scale (around the element's centre)}}}}. Scenes that load the Video Octopus scene kit (assets/octopus-scene.js, a copy of ${KIT}) apply them by themselves whenever they draw, so renders pick them up: don't bake them into the scene code, and keep element ids stable. To make an element movable, draw it inside Octopus.el('<id>', [x, y, w, h], () => { ... }, { label }) in a canvas scene, or give it data-studio="<id>" in an HTML scene.`,
    `Keyframes: an element's entry in work/overrides.json can also hold keys: [{t, dx, dy, s, o, e}], the creator's own keyframes from the scene timeline (◆). t = seconds on the render's timeline (the same as the production sheet), dx/dy = frame pixels, s = scale around the element's centre, o = opacity 0–1 (multiplies the element's own), e = "linear" or "hold" (default: ease in and out) for the way to the next key. Leave "at" out of entries you write: Video Octopus stamps the creator's own moves with it, and only those go into the change package. The kit (kit 2) interpolates them on top of your own animation whenever the scene draws, so the preview and every render show them; with keys, they replace that element's dx/dy/scale. Respect them: when you change a scene, keep element ids and their timing, don't animate the same property against the creator's keys, and if you have to move or rename a keyed element, say so and move its keys along with it (keep their times on the render timeline). Never remove keys unless the creator asks. If a project's assets/octopus-scene.js is older than kit 2, copy ${KIT} over it before relying on keys.`,
    namingContext(meta),
    ...(meta.doneByImport?.length ? ['This video was imported as already edited (the creator\'s own edit): the whole file is the cut (work/edl_manual.json), and Clean up and Lock the cut are done by import. Don\'t rough-cut it or check its joins unless the creator asks ("Clean it up anyway" in the Cut stage undoes this); transcribe it, and Split into sections and Plan the scenes work on it as the locked cut.'] : []),
    ...(dir ? kitContext(dir, meta) : []),
    ...learningProjectContext({...meta, learning: projectLearning(id,meta)}),
    blocksContext(),
    shotsContext(),
    `Everything in this project's window is a file you can change, and the window follows within a second: the layout and frame (project.json layout), the blocks (work/blocks.json), sound cues (work/sfx.json), notes and Look changes (work/notes.json), keyframes and moves (work/overrides.json), the post kit (work/post.json). So when the creator asks for a change anywhere in the window, make it in the file rather than describing where to click. Read the file first and change only the keys you mean to (keep the rest exactly). Changes you make yourself don't go into the change package; the creator's do. Your changes (in a reply or a step) apply directly: the creator sees them in the chat and can undo your last reply or step there.`,
    `The cut is work/edl_manual.json {segments_sec: [[start, end], …]}: the kept parts of the canvas take, in take seconds (the Cut tab and Scenes edit the same file). Change it only when asked; the Cut tab follows, and graphics are re-timed when the creator presses Save changes → Claude. Once the cut is locked (Lock the cut wrote "Cut locked" in WORKLOG.md) the Cut tab is read-only for the creator until they press Unlock to edit (WORKLOG then says "Cut unlocked"); only you write "Cut locked", when you lock it.`,
    `Saved layouts are in ${join(settings().studio || '<studio>', '.studio', 'layouts.json')} ({layouts: [{id, name, layout}]}, made with "+ Save layout"): to use one, copy its layout keys into project.json layout (keep aspect and layers). Library backgrounds (${join(settings().studio || '<studio>', 'library', 'backgrounds')}) are copied into the project's assets/ and used as bg {kind "image"|"video"|"code", file "assets/…", name}.`,
    `Things outside this project (Video Octopus's settings, other projects, scheduled runs, the library inbox) are the Video Octopus assistant's job (the Ask Claude button outside a project), which asks before each change: if the creator asks you for one, say so instead of changing Video Octopus's files.`,
    `When the creator asks what you'd change, be concrete: which layout or background per block, where a sound cue or block should go (with times), what to cut. Offer to apply it, and apply it in the files when they say yes.`,
    `The creator reads you in a narrow side panel: keep replies short and plain, and say what you're doing before long jobs. Talk about the video in their words (the cut, scene 3, the intro, the Cut tab's list, the change package), not in file names: leave paths like work/….json out of replies unless they ask where something is or a file is the thing they need to open.`,
  ].join('\n');
}

// A line Video Octopus adds to a project's chat log (kept and replayed like the chat's own, e.g. a finished step's marker):
// through the chat in use, else straight into its saved log and to the open pages. Like a GET, it never makes, starts
// or switches the chat.
function logEvent(id, ev) {
  const live = chats.get(id);
  if (live) return live.emit(ev);
  peekChat(id).emit(ev);
  broadcast(id, ev);
}

function broadcast(id, ev) {
  for (const res of streams.get(id) || []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
// A re-cut moved or merged shots or zooms (server/shots.mjs): one line each in the project's chat.
onShotNotes((dir, notes) => { const id = basename(dir); if (projectDir(id) === dir) for (const text of notes) logEvent(id, { t: 'note', text }); });

const exportJobs = new Map(); // project id -> last export job event (replayed to pages that open mid-export)

// A finished take from the recorder (browser-recorder.mjs) goes into the project it was recorded for: replace,
// layer or block, proxies, camera framing, events.
function takeArrived(id, takeDir, target, duration) {
  const dir = projectDir(id);
  if (!dir) return console.error(`The take ${takeDir} was recorded for ${id}, which is gone; it stays in the recordings folder.`);
  try {
    receiveTake(id, dir, takeDir, target, duration, 'Recorded');
  } catch (e) {
    broadcast(id, { t: 'take', error: `Couldn't import the take: ${e.message}` });
  }
}

// A finished take: replace the canvas take (and frame the camera around the head), or add it as new layers.
function receiveTake(id, dir, takeDir, target, duration, how = 'Imported') {
  logUse(how === 'Recorded' ? 'take.recorded' : 'take.imported', { project: id, ...(duration ? { secs: Math.round(duration) } : {}) });
  // A take recorded for a block (Record setup opened from a block or "@Sponsor read record new") becomes that block's file.
  if (/^block:/.test(target || '')) {
    const r = receiveBlockTake(dir, takeDir, target, how);
    makeProxies(dir, (ev) => broadcast(id, ev));
    broadcast(id, { t: 'take', files: r.files, duration, block: r.block, blockLabel: r.label });
    broadcast(id, { t: 'files' });
    return r.files;
  }
  const hadTake = roles(dir).files.length > 0;
  // A mic-only take has no picture to put in a box, so it always becomes the canvas take.
  const asLayer = target === 'layer' && hadTake && !takeIsAudioOnly(takeDir);
  const files = importTakeFrom(dir, takeDir, how, { keepActive: asLayer });
  if (asLayer) addLayers(dir, files);
  makeProxies(dir, (ev) => broadcast(id, ev));
  broadcast(id, { t: 'take', files, duration, layer: asLayer });
  broadcast(id, { t: 'files' });
  // Frame the new camera around the head (in the background; the canvas updates when it's done).
  const cam = files.find((f) => /_webcam\./i.test(f));
  if (cam) frameCamera(id, dir, asLayer ? { file: cam } : { main: true }).catch((e) => console.error(`Auto-frame after the take failed: ${e.message}`));
  return files;
}

// New files in source/ go on top of the canvas as layers (a take recorded or imported as a layer). At most 8 layers.
function addLayers(dir, files) {
  const meta = projectMeta(dir);
  const pics = files.filter((f) => !isAudio(f));
  const dims = Object.fromEntries(pics.map((f) => { const p = probe(dir, f); return [f, p?.w ? [p.w, p.h] : null]; }));
  const layout = normalize(meta.layout, meta.type);
  layout.layers = [...layout.layers, ...newLayers(layout, pics, dims)].slice(-8);
  saveProjectMeta(dir, { layout });
}

// What the Model and Effort pickers need to know about the agent: its model source, and the models it lists (Codex's
// own cache; pi's --list-models, at most every five minutes since it runs pi).
let piList = { at: 0, list: [] };
async function choiceContext(engine) {
  const c = section('claude');
  if (engine === 'claude') return { source: ccSource().id };
  if (engine === 'codex') return { local: codexSource(c) !== 'chatgpt', models: codexModels() };
  const endpoint = c.piSource === 'endpoint';
  if (!endpoint && Date.now() - piList.at > 300000) {
    try { piList = { at: Date.now(), list: (await piModels()).map((m) => ({ id: `${m.provider}/${m.model}`, label: `${m.provider} · ${m.model}` })) }; } catch {}
  }
  return { endpoint, models: endpoint ? [] : piList.list };
}

// A video whose editing copies were deleted after an export is being edited again: with Optimise for editing on,
// its copies are made again in the background (playback.mjs makeProxies, demand). The originals play meanwhile.
function editedAgain(id, dir) {
  try { if (projectMeta(dir)?.copiesDeleted && playbackMode(dir) === 'optimise') makeProxies(dir, (ev) => broadcast(id, ev), { demand: true }); }
  catch (e) { console.error(`Editing copies for ${id}: ${e.message}`); }
}

// Why the project's media can't be moved or switched right now (the Media section, server/media.mjs), or null.
function mediaBusy(id, dir) {
  if (chats.get(id)?.busy) return 'Claude is working in this project: wait for it or stop it first.';
  if (packagingBusy(id)) return 'Codex is working in this project’s Packaging: wait for it or stop it first.';
  if (exportInfo(id, dir).running || layersRunning(id) || audioRunning(id)) return 'An export is running for this project: wait for it to finish, or stop it.';
  return null;
}

function takeIsAudioOnly(takeDir) {
  try {
    const files = readdirSync(takeDir).filter((f) => !f.startsWith('.') && isTakeFile(f));
    return files.length > 0 && files.every(isAudio);
  } catch { return false; }
}

async function frameCamera(id, dir, which) {
  const meta = projectMeta(dir);
  const layout = normalize(meta.layout, meta.type);
  const file = which.main ? canvasSources(dir).cam : which.file;
  if (!file) throw new Error('There is no camera to frame.');
  const p = probe(dir, file);
  const shape = which.main ? layout.cam.shape : layout.layers.find((x) => x.file === file)?.shape;
  const fr = await autoFrame(join(dir, 'source', file), p?.duration, { shape });
  if (!fr) return { layout, found: false };
  const fresh = normalize(projectMeta(dir).layout, meta.type);
  // A cropped camera zooms inside what its crop leaves (web/layout.js cropIn): the same head-and-shoulders height.
  const fit = (f) => ({ ...fr, zoom: Math.round(Math.min(4, Math.max(1, fr.zoom * (1 - (f.crop?.t || 0) - (f.crop?.b || 0)))) * 1000) / 1000 });
  if (which.main) Object.assign(fresh.cam, fit(fresh.cam));
  else for (const x of fresh.layers) if (x.file === file) Object.assign(x, fit(x));
  saveProjectMeta(dir, { layout: fresh });
  broadcast(id, { t: 'files' });
  return { layout: fresh, found: true };
}
const exportEmit = (id) => (ev) => {
  if (ev.t === 'job') { if (ev.done) exportJobs.delete(id); else exportJobs.set(id, ev); }
  // A finished export (a stopped one also ends "ok", but leaves no file or folder) goes into the usage log.
  if (ev.t === 'job' && ev.done && ev.ok && (ev.file || ev.out || ev.folder)) {
    logUse('export.done', { project: id, kind: ev.kind || 'video' });
    // A completed export is a useful local checkpoint; never starts a paid agent turn.
    try { const c = chats.get(id) || makeChat(id, () => projectContext(id)); c.memoryBinding = { project: id }; c.memoryCheckpoint('export-complete'); } catch {}
  }
  broadcast(id, ev);
};

// Watch the project folder while someone has it open, so steps and the Cut tab refresh themselves.
function watchProject(id, dir) {
  if (watchers.has(id)) return;
  let timer = null;
  const changed = new Set();
  // The cut changed (Cut tab, the Cut Editor on its own, or Claude), or a sheet or render was written: keep the
  // package's cut item and the scenes' cut snapshot in step (cutsync.mjs), and say so in the chat when it first appears.
  const cutHooks = (files) => {
    try {
      // Claude changed the layout or the blocks itself (its turn is running or just ended, and the window saved nothing
      // just now): that's already done, so it becomes the package's starting point instead of a change waiting for Claude.
      const doc = files.some((f) => f === 'work/blocks.json' || f === 'project.json');
      if (doc) owner.onDocFiles(id, dir);
      noteBuildFiles(id, dir, files); // a scene marked building between two page reads (B5b)
      for (const n of onProjectFiles(dir, files) || []) broadcast(id, { t: 'note', text: `Added to the change package: ${n.text}` });
    } catch (e) { console.error('cut sync:', e.message); }
  };
  try { cutHooks(['work/edl_manual.json', 'work/blocks.json', 'project.json']); } catch {}
  try {
    const w = watch(dir, { recursive: true }, (_e, file) => {
      if (file && /(^|\/)(seq|frames|parts|masks)[^/]*\//.test(file)) return; // render frames: too noisy
      if (file) changed.add(String(file).split('\\').join('/'));
      clearTimeout(timer);
      timer = setTimeout(() => { const files = [...changed]; changed.clear(); cutHooks(files); try { usageFromFiles(id, dir, files); } catch {} broadcast(id, { t: 'files' }); }, 700);
    });
    watchers.set(id, w);
  } catch {}
}

// A step's brief goes to the project's chat (the dock's Run, a stage's list, the empty states; /step). Returns its text.
async function startStep(id, dir, stepId) {
  const meta = projectMeta(dir);
  if (!meta?.type) throw new Error('Pick a project type first.');
  // Transcribing steps follow Settings → Transcription (a cloud service without its key: this computer, said once).
  const tx = ['prepare', 'transcribe'].includes(stepId) ? await transcribeHow({ fill: stepId === 'prepare' }) : null;
  let text = stepBrief(dir, meta.type, stepId) || stepPrompt(dir, meta.type, stepId, { transcribe: tx?.text });
  // The chat shows where the step's work starts as one line, "▶ Build the intro · started 14:32", with Video Octopus's
  // brief folded under it (the user event's brief), and names a new session after the step.
  const st = pipelineStatus(dir, meta.type), step = [...(st?.steps || []), ...(st?.more || [])].find((x) => x.id === stepId);
  text += guardLearnedStep(id,dir,step);
  if (tx?.fallback && !state().noKeyTold?.[tx.fallback]) {
    chatFor(id).emit({ t: 'note', text: `Transcription is set to ${tx.fallback} in Settings, but no ${tx.fallback} key is saved, so ${step?.name || 'this step'} transcribes on this computer (${tx.model}). Add the key in Settings → Transcription to use ${tx.fallback}.` });
    patchState({ noKeyTold: { ...(state().noKeyTold || {}), [tx.fallback]: new Date().toISOString() } });
  }
  stepRuns.set(id, { step: stepId, at: Date.now() });
  startBuildRun(id, dir, step); // a Build step: its progress per scene, from the sheet's marks (B5b)
  clearUnfinished(id);
  await chatFor(id).send(text, { brief: { step: stepId, name: String(step?.name || step?.label || stepId).slice(0, 60) } });
  noteStep(id, stepId);
  return text;
}

// ---- helpers ----
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// A request's JSON body (util.mjs): {} when empty; too large or not JSON throws an error with status 413 or 400, which
// the route's catch (or the server's, below) sends as it is. Every route module gets this same reader as `body`.
const body = (req, limit = 1e6) => readJSONBody(req, limit);

async function serveFile(req, res, file, { trusted = false, root = file && dirname(file) } = {}) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
  const ext = extname(file).toLowerCase();
  if (trusted && ['.html', '.htm'].includes(ext)) res.setHeader('Content-Security-Policy', `frame-src 'self' ${await sandboxOrigin()}; object-src 'none'`);
  // Downloading/viewing a project file must not turn it into editor-origin script. These checks
  // also cover /media and library routes, including files supplied as HTML/SVG rather than scenes.
  if (!trusted && ['.html', '.htm', '.svg', '.js', '.mjs'].includes(ext)) {
    if (['script', 'worker', 'sharedworker', 'serviceworker'].includes(req.headers['sec-fetch-dest'])) return send(res, 403, { error: 'Generated code runs only in the rendering sandbox.' });
    if (['.html', '.htm'].includes(ext) || (ext === '.svg' && req.headers['sec-fetch-dest'] !== 'image')) {
      const scope = await createSceneSandbox({ root, file, search: new URL(req.url, `http://127.0.0.1:${PORT}`).search });
      res.writeHead(302, { Location: scope.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
    }
    if (ext === '.js' || ext === '.mjs') res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'");
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const size = statSync(file).size;
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}

// Only this app's own page may call the API (blocks other sites and DNS rebinding).
function allowed(req) {
  const hostOk = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);
  const origin = req.headers.origin;
  const originOk = !origin || [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin);
  const writeOk = req.method === 'GET' || req.headers['x-studio'] === '1';
  const site = req.headers['sec-fetch-site'];
  return hostOk && originOk && writeOk && (!site || site === 'same-origin' || site === 'none');
}

// The video's style for the record panel's remembered sources (browser-recorder.mjs recorderChoices): its style's id and
// name, or its setup when it has no style.
function styleOf(id, ctx = withProjectChannels([{ id }])[0]) {
  return ctx?.formatId ? { key: `style:${String(ctx.formatId).replace(/[^\w.-]/g, '_').slice(0, 80)}`, name: ctx.formatName || null } : null;
}

function projectView(id, dir) {
  const meta = projectMeta(dir) || {};
  const pinned = withProjectChannels([{ id }])[0];
  const r = roles(dir);
  // What the editor plays for each file (server/playback.mjs): its 720p copy, else the original when the browser plays
  // it, else null (a copy is being made). A sound file (mic-only take) plays as it is. Never waits for a copy.
  const proxies = Object.fromEntries(r.files.map((f) => [f, playSource(dir, f).src]));
  const busy = Boolean(chats.get(id)?.busy); // read only: a GET never makes or switches the chat
  const pipeline = meta.type ? pipelineStatus(dir, meta.type, { lines: true, seen: railSeen(id) }) : null;
  return {
    id, name: meta.name || id, nameSource: meta.nameSource === 'auto' ? 'auto' : 'manual', autoNamedBy: meta.autoNamedBy || null,
    // The style and format it uses (its pinned setup), for the editor's style picker.
    context: (({ profileId, profileName, formatId, formatName }) => ({ profileId, profileName, formatId, formatName }))(pinned),
    learning: projectLearning(id,meta), type: formatId(meta.type), shortStyle: meta.shortStyle || null, app: Boolean(projectMeta(dir)),
    path: dir, layout: normalize(meta.layout, meta.type),
    // The steps with their words, each done step's line, and the newest step finished since the page last looked.
    roles: r, canvas: canvasSources(dir), proxies, playback: playbackView(dir), pipeline,
    running: busy ? stepRuns.get(id)?.step || null : null, // the step Claude is working on (the dock on the message box)
    runningAt: busy ? stepRuns.get(id)?.at || null : null, // when it started (the dock shows how long it has run)
    // A Build step's progress per scene while it runs (server/build-progress.mjs; null until Claude marks a scene).
    build: busy && stepRuns.get(id) ? buildProgress(id, dir) : null,
    cut: cutPlan(dir), busy, renders: listRenders(dir),
    export: exportInfo(id, dir), recorder: recorderChoices(id, styleOf(id, pinned)), recUnfinished: unfinishedTakes(id), scenes: scenesSummary(dir), kit: kitSummary(dir, meta), editing: section('editing'),
    brandColors: profilePalette(id) ?? section('look').colors, // Settings → Look → Brand (and the Brand kit): the canvas's border picker offers them
    blocks: blocksSummary(dir), prepare: prepareState(id, dir, busy),
    layerExports: listLayerExports(dir), // Layers and Timeline file exports (server/export-layers.mjs)
    textExports: listTextExports(dir, probeFile), // Audio, Transcript and Subtitles exports (server/export-text.mjs)
    joins: cutReadOnly(dir) ? [] : joinFlags(dir), // the join check's flags on the canvas timeline (server/timeline.mjs); none while the cut is locked (B3)
    finalRender: meta.finalRender || null, // the render marked Final on the Renders tab
    // Shots and zooms (server/shots.mjs, web/shots.js): work/shots.json { v: 1, shots } and work/zooms.json { v: 2, items },
    // settled (sections, re-cuts, block layouts moved in) and on the take's own seconds; the page refreshes on any change.
    ...shotsView(dir),
    // A step whose turn ended without its result ("Didn't finish", server/turns.mjs), and what each tab had when the
    // creator last opened it (its glow survives a reload).
    unfinished: unfinishedOf(id, pipeline),
    tabSeen: state().projects?.[id]?.tabSeen || null,
    // The last Save changes → Claude: when, and once its turn ended, what came of it (B6, the Scenes panel's line).
    // left: the sent items still open or not marked done now (read live, so resolving one in Scenes takes it away):
    // Claude's state is "finished with open items" while there are any (web/rail.js, web/attention.js 'notes').
    packageRun: packageRunView(dir, state().projects?.[id]?.packageRun),
  };
}
const shotsView = (dir) => { try { return readShotsAndZooms(dir); } catch (e) { console.error('shots:', e.message); return { shots: null, zooms: { v: 2, items: [] } }; } };

// The steps that were done when the page last looked at a project (local state; null until it first does, so a
// project opened for the first time after an update shows no done moment or chat marker for old steps).
const railSeen = (id) => { const v = state().projects?.[id]?.railSeen; return Array.isArray(v) ? v : null; };

function listRenders(dir) {
  try {
    // What each is (server/built.mjs): a Build step's video ("Intro builds"), Export → Video ("Video exports"), or other.
    const steps = buildSteps(projectMeta(dir)?.type), id = basename(dir), what = { export: 'Video export', other: null };
    return readdirSync(join(dir, 'renders')).filter((f) => /\.(mp4|mov)$/i.test(f))
      .map((f) => { const st = statSync(join(dir, 'renders', f)), k = renderKind(id, f, steps);
        return { file: `renders/${f}`, at: st.mtimeMs, bytes: st.size, kind: k.kind, group: k.group, what: k.kind === 'build' ? `${k.label} build` : what[k.kind] }; })
      .sort((a, b) => b.at - a.at).slice(0, 12)
      // length, size and sound for the Renders tab (ffprobe, cached until the file changes; half-written files skipped)
      .map((r) => { const p = r.bytes > 0 ? probeFile(join(dir, r.file)) : null; return p ? { ...r, duration: p.duration, w: p.w, h: p.h, audio: p.audio, codec: p.codec } : r; });
  } catch { return []; }
}

// ---- routes ----
async function route(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // The background kit (core/kit), for the canvas backgrounds and the export's headless renderer.
  if (p.startsWith('/kit/')) return serveFile(req, res, inside(join(APP_DIR, 'core', 'kit'), '.' + p.slice(4)), { trusted: true });
  if (!p.startsWith('/api/')) {
    // A folder's page is its index.html (the Cut Editor's is /cut-editor/).
    const file = p === '/' ? join(WEB, 'index.html') : inside(WEB, '.' + (p.endsWith('/') ? `${p}index.html` : p));
    return serveFile(req, res, file, { trusted: true });
  }
  if (!allowed(req)) return send(res, 403, { error: 'Forbidden' });
  if (p === '/api/sandbox' && req.method === 'POST') {
    const b = await body(req);
    try {
      const src = new URL(b.src, `http://127.0.0.1:${PORT}`);
      if (![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(src.origin) || !['scene', 'background'].includes(b.kind)) throw new Error('Unsupported rendering source.');
      const project = /^\/api\/projects\/([^/]+)\/files\/(.+)$/.exec(src.pathname);
      const library = /^\/api\/library\/backgrounds\/([^/]+)$/.exec(src.pathname);
      let root, file;
      if (project) { root = projectDir(decodeURIComponent(project[1])); file = root && inside(root, project[2].split('/').map(decodeURIComponent).join('/')); }
      else if (library) { file = libraryFile(decodeURIComponent(library[1])); root = file && dirname(file); }
      if (!file || !root) throw new Error('No such rendering source.');
      const scope = await createSceneSandbox({ root, file, kind: b.kind, search: src.search });
      return send(res, 200, { url: scope.url });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (!['GET', 'HEAD'].includes(req.method) && !['/api/app/updates', '/api/app/updates/check', '/api/app/updates/restart'].includes(p)) {
    try { assertNotUpdating(); } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (await memoryRoute(req, res, url, { studio: settings().studio, body, send, logRoot: join(LOCAL_DIR, 'chats') })) return;
  // Settings, Setup and the Video Octopus assistant (server/setup.mjs, server/assistant.mjs).
  // The Dashboard: totals from the folders, features and activity from the local usage log (server/usage.mjs).
  if (p === '/api/app/dashboard/catch-up' && req.method === 'POST') return send(res, 200, catchUpUsage());
  // Settings › Storage › Playback: the space the 720p editing copies use in every video, and Delete all copies.
  if (p === '/api/app/playback-copies' && req.method === 'GET') return send(res, 200, allCopies());
  if (p === '/api/app/playback-copies/delete' && req.method === 'POST') return send(res, 200, { ...deleteAllCopies(), ...allCopies() });
  if (p === '/api/app/dashboard') return send(res, 200, dashboard(['week', 'month'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : 'all'));
  // The numbers in Home's sidebar: scheduled runs that are on, pieces waiting in the Library inbox, and (update) new
  // commits for the app, the badge on Settings.
  if (p === '/api/app/counts') {
    let inbox = 0; try { inbox = settings().studio ? inboxItems().length : 0; } catch {}
    const skillUpdates = settings().studio ? managedSkillsView().pending : 0;
    // channels: the sidebar's My style rows (Direction A), read-only from the studio database.
    const channels = settings().studio ? channelSummaries() : [];
    // waiting: Home's "Waiting for you" chips (Everything memories to review, format drafts to review).
    const waiting = settings().studio ? studioWaiting() : { memories: 0, drafts: { count: 0, formatId: null } };
    return send(res, 200, { schedules: readSchedules().filter((x) => x.enabled).length, inbox, skillUpdates, channels, waiting, update: await updateCount() });
  }
  // Settings → Updates: the app's update (git), Restart, starter files, Open Video Octopus when I log in (server/updates.mjs).
  if (await updatesRoute(req, res, url, { send, body, restart: () => shutdown(RESTART_CODE) })) return;
  if (await schedulesRoute(req, res, url, { send, body })) return;
  // The editor's style picker (design V2 §6): pin another style and format to an existing project, as New video does.
  const pick = /^\/api\/project-context\/([^/]+)\/select$/.exec(p);
  if (pick && req.method === 'POST') {
    let pid = '';
    try { pid = decodeURIComponent(pick[1]); } catch {}
    const b = await body(req);
    const live = chats.get(pid);
    if (live?.busy) return send(res, 409, { error: 'Wait for the agent to finish its reply, then change the style.' });
    try {
      const result = selectProjectContext(pid, b);
      restartWhenIdle(live); // the project's chat starts again with the new setup (its conversation carries on)
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message, ...(e.needsConfirm ? { needsConfirm: true } : {}) });
    }
  }
  // The editor's shape chip in Simple mode (Decision 5): YouTube video 16:9 ⇄ Reel or Short 9:16, until Build without
  // asking, after it with confirm: true (409 needsConfirm first). GET: the shape New video ▾ preselects.
  if (p === '/api/simple/last-shape' && req.method === 'GET') return send(res, 200, { shape: lastSimpleVideo() });
  const shapeRoute = /^\/api\/project-context\/([^/]+)\/shape$/.exec(p);
  if (shapeRoute && req.method === 'POST') {
    let pid = '';
    try { pid = decodeURIComponent(shapeRoute[1]); } catch {}
    const b = await body(req);
    const live = chats.get(pid);
    if (live?.busy) return send(res, 409, { error: 'Wait for the agent to finish its reply, then change the shape.' });
    try {
      const result = switchProjectShape(pid, b);
      if (!result.unchanged) restartWhenIdle(live);
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message, ...(e.needsConfirm ? { needsConfirm: true } : {}) });
    }
  }
  if (await profileRoute(req, res, url, { send, body, serveFile })) return;
  // Packaging (thumbnails, its Codex chat) and the resources it uses (server/packaging.mjs).
  if (p.startsWith('/api/packaging/') && await packagingRoute(req, res, url, { send, body })) return;
  if ((p === '/api/resources' || p.startsWith('/api/resources/')) && await resourcesRoute(req, res, url, { send, body })) return;
  // Simple mode's Resources page: the built-in brand's look and its files (server/simple-resources.mjs).
  if ((p === '/api/simple-resources' || p.startsWith('/api/simple-resources/')) && await simpleResourcesRoute(req, res, url, { send, body })) return;
  if (await learningRoute(req, res, url, { send, body, serveFile })) return;
  // Which agent runs the chats (Settings → Claude): Claude Code or Codex, and what each install reports.
  if (p === '/api/app/engines' && req.method === 'GET') return send(res, 200, await enginesView(url.searchParams.has('refresh'), { models: url.searchParams.has('models'), source: url.searchParams.has('source') }));
  // Archived projects: moved aside into <projects>/_archive/ (hidden from Home, never deleted), listed and brought back.
  if (p === '/api/app/archive' && req.method === 'POST') {
    const b = await body(req), arch = join(projectsRoot(), '_archive');
    if (b.op === 'list') { let names = []; try { names = readdirSync(arch).filter((n) => !n.startsWith('.')); } catch {} return send(res, 200, { archived: names }); }
    if (b.op === 'restore') {
      const aid = String(b.id || '');
      if (!/^[\w.-]+$/.test(aid) || aid.startsWith('.') || !existsSync(join(arch, aid))) return send(res, 400, { error: 'No such archived project.' });
      if (existsSync(join(projectsRoot(), aid))) return send(res, 400, { error: `A project called ${aid} exists already.` });
      await renameFolder(join(arch, aid), join(projectsRoot(), aid));
      return send(res, 200, { restored: aid });
    }
    return send(res, 400, { error: 'Unknown archive action' });
  }
  if (await onboardingRoute(req, res, url, { send, body })) return; // brand kit uploads, BRAND.md, skills from GitHub (server/onboarding.mjs)
  if (await assistantRoute(req, res, url, { send, body }) || await appRoute(req, res, url, { send, body })) return;
  if (await inboxRoute(req, res, url, { send, body })) return; // the Library inbox (server/inbox.mjs)
  // Library add: a file inside the studio copied into a library section, with its INDEX.md line.
  if (p === '/api/library/add' && req.method === 'POST') {
    const b = await body(req);
    try {
      const src = inside(settings().studio, String(b.file || ''));
      if (!src) throw new Error('Only files inside the studio folder can go into the library.');
      return send(res, 200, addToLibrary(String(b.kind || ''), src, { name: b.name, note: b.note }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if ((p === '/api/library' || p.startsWith('/api/library/')) && await libraryRoute(req, res, url, { send, body, serveFile })) return;

  if (p === '/api/plan-usage' && req.method === 'GET') return send(res, 200, {engine:engineName(),usage:modelSourceView()?null:getPlanUsage(engineName())});

  if (p === '/api/status' && req.method === 'GET') {
    const s = settings();
    const studioOk = Boolean(s.studio) && existsSync(s.studio);
    return send(res, 200, {
      studio: s.studio, studioOk, projectsDir: s.projectsDir, recordingsDir: s.recordingsDir,
      permissionMode: s.permissionMode, model: s.model,
      claude: await claudeInfo(url.searchParams.has('refresh')),
      // The selected agent (Claude Code, Codex or pi), for the top bar's chip, Home's sidebar card and the install notice
      // (Claude Code's own check, just above, already refreshed it).
      agent: await agentStatus(url.searchParams.has('refresh') && engineName() !== 'claude'),
      // modelSource: Claude Code on another model than the plan (then there are no plan limits to show).
      formats: formats(), formatInfo: formatInfo(), usage: modelSourceView() ? null : getPlanUsage(engineName()), modelSource: modelSourceView(), engine: engineName(), engineLabel: ENGINES[engineName()],
      // Settings › General › Editor mode: simple (default) or advanced; the web's gate is web/mode.js isAdvanced().
      // lastShape: the shape New video ▾ preselects (the last one chosen).
      editor: { ...section('editor', s), lastShape: lastSimpleVideo() },
      appearance: section('appearance', s), // Settings → Appearance: how Video Octopus looks (web/appearance.js applies it)
      help: section('help', s), // first-time help seen (help.stepsIntro: 'dismissed')
      // Settings › Storage: what Delete recording does, and the computer's Bin it uses (null: none, the studio's trash).
      storage: { ...section('storage', s), bin: binName() },
      ffmpeg: await ffmpegReady(), // Export stays off without it (Setup installs it)
      // The computer, for the page: "Show in Finder" or "Show in File Explorer", and paths shortened to ~.
      platform: process.platform, home: homedir(),
    });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await body(req);
    const patch = {};
    for (const k of ['studio', 'projectsDir', 'recordingsDir', 'permissionMode', 'model']) if (typeof b[k] === 'string') patch[k] = b[k];
    if (patch.studio && !existsSync(expandHome(patch.studio))) return send(res, 400, { error: 'That folder does not exist.' });
    const s = saveSettings(patch);
    if (patch.permissionMode || patch.model !== undefined) for (const c of chats.values()) c.restart();
    return send(res, 200, s);
  }
  if (p === '/api/projects' && req.method === 'GET') return send(res, 200, withProjectChannels(listProjects()));
  if (p === '/api/projects' && req.method === 'POST') {
    let b = await body(req);
    if (!b.untitled && !b.name?.trim()) return send(res, 400, { error: 'Give the project a name.' });
    try {
      // New video (design V2 §6): "Untitled video" with the last-used style and format (or the ones given), named
      // automatically later (server/naming.mjs).
      // Simple mode's New video ▾ (V1 spec §2–§3) sends shape: youtube | reel | audio, the built-in style's format.
      const shape = b.shape ? String(b.shape) : null;
      if (shape) b = { ...b, ...simpleVideoChoice(shape), name: b.untitled ? UNTITLED : b.name, nameSource: b.untitled ? 'auto' : b.nameSource };
      else if (b.untitled) b = { ...b, ...newVideoChoice(b), name: UNTITLED, nameSource: 'auto' };
      const id = createConfiguredProject(b);
      if (shape) { rememberSimpleVideo(shape); resourcesForNewVideo(id); }
      else if (b.untitled) rememberNewVideo(b);
      const dir = projectDir(id);
      logUse('project.created', { project: id, type: b.type || null });
      if (b.take) { importTake(dir, b.take); logUse('take.imported', { project: id }); makeProxies(dir, (ev) => broadcast(id, ev)); }
      return send(res, 200, { id });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/takes') return send(res, 200, listTakes().map((t) => ({ ...t, duration: takeDuration(t) })));
  // The Recordings page: the takes, and the files dropped or imported into videos, listed where they are (A17,
  // server/media.mjs importedRecordings), newest first.
  if (p === '/api/recordings') {
    return send(res, 200, [...listTakes().map((t) => ({ ...t, duration: takeDuration(t) })), ...importedRecordings()].sort((a, b) => b.at - a.at));
  }
  // Settings › Storage › Trash (list, Put back, Empty trash) and the Recordings page's Delete with its Undo (server/trash.mjs).
  if (await trashRoute(req, res, url, { send, body, busy: mediaBusy, emit: broadcast })) return;
  // Saved layouts (the canvas's "+ Save layout"), shared by every project of the studio (server/saved-layouts.mjs).
  if (p === '/api/layouts') return layoutsRoute(req, res, { send, body, touched: (pid) => owner.touch(pid) });
  // Built-in recorder takes that never got saved (the page closed mid-take), for every project: Home lists them.
  if (p === '/api/rec-unfinished') return send(res, 200, { takes: unfinishedTakes(null) });
  if (p === '/api/skills') return send(res, 200, listSkills(url.searchParams.get('type')));
  // Backgrounds: the library's files, and the export's headless background renderer.
  const lb = /^\/api\/library\/backgrounds\/([^/]+)$/.exec(p);
  if (lb) { let n = ''; try { n = decodeURIComponent(lb[1]); } catch {} return serveFile(req, res, libraryFile(n)); }
  if (p.startsWith('/api/bgjob/')) return bgJobRoute(req, res, p, send);

  // Project files by path, so a scene's HTML loads its own fonts and images (the Scenes tab frames it).
  const pf = /^\/api\/projects\/([^/]+)\/files\/(.+)$/.exec(p);
  if (pf) {
    const pdir = projectDir(decodeURIComponent(pf[1]));
    let rel = '';
    try { rel = pf[2].split('/').map(decodeURIComponent).join('/'); } catch {}
    const file = pdir && rel ? inside(pdir, rel) : null;
    // The scene kit reads work/overrides.json and work/production.json when a scene loads; a project may have neither
    // yet, which is fine: answer "nothing" rather than a 404 in the console.
    if (file && OPTIONAL_KIT_READS.has(rel) && !existsSync(file)) return send(res, 200, null);
    return serveFile(req, res, file, { root: pdir });
  }
  // The Cut Editor's page (web/cut-editor/) reads the take, its words and the cut, and saves the cut (server/cuteditor.mjs).
  const ce = /^\/api\/projects\/([^/]+)\/cut\/(data\.json|version|video|notes|notes\/delete|save)$/.exec(p);
  if (ce) {
    const cdir = projectDir(decodeURIComponent(ce[1]));
    if (!cdir) return send(res, 404, { error: 'No such project' });
    if (await cutEditorRoute(req, res, { dir: cdir, what: ce[2], send, body, serveFile })) return;
    return send(res, 405, { error: 'Not here' });
  }
  const m = /^\/api\/projects\/([^/]+)(\/[a-z-]+)?$/.exec(p);
  if (!m) return send(res, 404, { error: 'Unknown route' });
  const id = decodeURIComponent(m[1]);
  const dir = projectDir(id);
  if (!dir) return send(res, 404, { error: 'No such project' });
  const action = m[2] || '';

  if (action === '' && req.method === 'GET') return send(res, 200, projectView(id, dir));
  if (KIT_ACTIONS.has(action)) return kitRoute(action, req, res, url, { id, dir, send, body, chat: () => chatFor(id) });

  if (action === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const chat = peekChat(id); // events still arrive from the chat a later POST makes (broadcast goes by project id)
    const open = new Set(chat.openRequests());
    const history = chat.history();
    const done = new Set(history.filter((e) => e.t === 'permission_done').map((e) => e.id));
    for (const ev of forReplay(history)) {
      // Old approval cards that nobody answered and Claude no longer waits on show as expired.
      if ((ev.t === 'permission' || ev.t === 'question') && !open.has(ev.id) && !done.has(ev.id)) ev.expired = true;
      res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ t: 'busy', busy: chat.busy })}\n\n`);
    if (chat.contextEvent()) res.write(`data: ${JSON.stringify(chat.contextEvent())}\n\n`);
    // The model the session runs on (the "· opus…" next to Claude), also after a reload.
    const sm = state().projects?.[id]?.model;
    if (sm) res.write(`data: ${JSON.stringify({ t: 'session', model: sm, replay: true })}\n\n`);
    if (exportJobs.has(id)) res.write(`data: ${JSON.stringify(exportJobs.get(id))}\n\n`);
    if (!streams.has(id)) streams.set(id, new Set());
    streams.get(id).add(res);
    watchProject(id, dir);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); streams.get(id)?.delete(res); });
    return;
  }
  if (action === '/media') {
    const rel = url.searchParams.get('f') || '';
    return serveFile(req, res, inside(dir, rel), { root: dir });
  }
  if (action === '/timeline') return send(res, 200, await timelineData(dir));
  // Home's Continue card: how long the video is (the locked cut, else the take) and how many scenes it has.
  if (action === '/summary') {
    const cut = lockedCut(dir), main = canvasSources(dir);
    const take = main.cam || main.screen || main.audio;
    const length = cut ? cut.segments.reduce((t, [a, b]) => t + Math.max(0, b - a), 0) : take ? probe(dir, take)?.duration || 0 : 0;
    return send(res, 200, { length, cut: Boolean(cut), scenes: scenesSummary(dir)?.count || 0 });
  }
  if (action === '/scenes') return send(res, 200, scenesView(dir));
  // Scenes trims the cut too: the take the Cut Editor plays, its words and the cut now (server/cutsync.mjs).
  if (action === '/cut-take') return send(res, 200, cutTake(dir));
  if (action === '/peaks') {
    const rel = url.searchParams.get('f') || '';
    if (!inside(dir, rel)) return send(res, 400, { error: 'Bad file' });
    return send(res, 200, (await filePeaks(dir, rel)) || { rate: 0, data: [] });
  }
  if (action === '/backgrounds') return send(res, 200, listBackgrounds(dir));
  if (action === '/thumb') {
    const file = await thumbFor(id, dir);
    if (!file) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); } // no picture yet: nothing to show, not an error
    return serveFile(req, res, file);
  }
  // The Cut tab's review list: Claude's reasons for each cut, what Prepare asked about, Keep / Cut decisions.
  if (await cutReviewRoute(req, res, { dir, action, send, body })) return;
  // Edits made in the window (layout, blocks) go into the change package; the same files changed by Claude during its
  // turn don't (watchProject tells them apart by this time). Read-only routes (the rail's "seen") aren't edits.
  if (req.method === 'POST' && UI_ROUTES.includes(action)) owner.touch(id);
  if (req.method === 'POST' && UI_ROUTES.includes(action)) editedAgain(id, dir); // copies deleted after an export come back (Optimise)
  // Blocks (M3b): the band, the strip, @mentions and dropped files (uploads stream, so this comes before the JSON body).
  if (await blocksRoute(req, res, { dir, action, url, send, body, chat: () => chatFor(id), broadcast: (ev) => broadcast(id, ev) })) return;
  // Shots and zooms (server/shots.mjs): GET /shots, /zooms; POST { op, … } like /blocks.
  if (await shotsRoute(req, res, { dir, action, send, body })) return;
  // Export → Layers / Timeline file (server/export-layers.mjs; reads its own body, the canvas PNGs are large).
  if (await layersRoute(req, res, { id, dir, action, send, body, emit: exportEmit(id) })) return;
  // The built-in recorder's chunks (raw bodies, so this comes before the JSON body), finish and recovery.
  if (await recRoute(req, res, { id, action, url, send, body, emit: (ev) => broadcast(id, ev), receiveTake: takeArrived, style: () => styleOf(id) })) return;
  // The chat panel's Model and Effort pickers (server/agent-choices.mjs): GET what they show, POST { model?, effort? }
  // ('studio' = follow Settings again). Checked against an allow-list or a strict pattern; Claude Code and pi restart
  // their process once idle so the next message uses it, Codex sends it with the next turn.
  if (action === '/agent-choice') {
    const engine = engineName();
    try {
      if (req.method === 'POST') {
        const b = await body(req);
        setAgentChoice(id, engine, { ...('model' in b ? { model: b.model } : {}), ...('effort' in b ? { effort: b.effort } : {}) });
        const c = chats.get(id);
        if (c && c.engine === engine && engine !== 'codex') restartWhenIdle(c);
      }
      return send(res, 200, choiceView(id, engine, await choiceContext(engine)));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // The Media section (server/media.mjs): list, use an older take, add as a layer, remove to the trash, Delete recording
  // (this video and Recordings, to the computer's Bin: trash.mjs binEntry), Undo.
  if (await mediaRoute(req, res, { dir, action, send, body, emit: (ev) => broadcast(id, ev), busy: () => mediaBusy(id, dir),
    frame: (file) => frameCamera(id, dir, { file }), toBin: binEntry })) return;
  // Export → Audio / Transcript / Subtitles (server/export-audio.mjs, server/export-text.mjs).
  if (await audioRoute(req, res, { id, dir, action, url, send, body, emit: exportEmit(id) })) return;
  if (await textRoute(req, res, { id, dir, action, url, send, body })) return;
  // The record panel's script (POST /script below saves it): empty when there's none, so the page logs no 404.
  if (action === '/script' && req.method === 'GET') { const f = join(dir, 'script.md'); return send(res, 200, { text: existsSync(f) ? readFileSync(f, 'utf8') : '' }); }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  // New project → "Import a file…": the file becomes the take (streams, so before the JSON body).
  if (action === '/take-upload') {
    try {
      // ?target=layer (Media → Add as a layer → Import a file…): a video comes in on top; the canvas take stays.
      const asLayer = url.searchParams.get('target') === 'layer' && roles(dir).files.length > 0;
      const files = await importUpload(dir, req, url.searchParams.get('name') || 'take.mp4', { keepActive: asLayer });
      if (asLayer && files.some((f) => !isAudio(f))) addLayers(dir, files);
      makeProxies(dir, (ev) => broadcast(id, ev));
      broadcast(id, { t: 'files' });
      return send(res, 200, { files });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/background-upload') {
    try { return send(res, 200, { bg: await saveUpload(dir, req, url.searchParams.get('name') || '') }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  const b = await body(req, action === '/export' ? 60e6 : 1e6);

  if (action === '/chat' || action === '/step') editedAgain(id, dir);
  if (action === '/chat') {
    // Send again (a turn that stopped): the last message or step brief. A step's brief runs as that step again.
    if (b.retry === true) {
      try {
        const c = chatFor(id);
        if (c.lastBrief?.step && !c.busy) {
          stepRuns.set(id, { step: c.lastBrief.step, at: Date.now() }); clearUnfinished(id);
          const meta = projectMeta(dir), st = meta?.type ? pipelineStatus(dir, meta.type) : null;
          startBuildRun(id, dir, st?.steps.find((x) => x.id === c.lastBrief.step));
        }
        await c.retry();
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (!b.text?.trim()) return send(res, 400, { error: 'Empty message' });
    try { await chatFor(id).send(b.text.trim(), { brief: b.memoryReview === true ? { name: 'Review lessons' } : null }); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (action === '/step') {
    try { return send(res, 200, { ok: true, text: await startStep(id, dir, b.step) }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  // Already-edited footage (B9): the file just imported is the creator's own edit. The whole take becomes the cut,
  // Clean up and Lock the cut are done by import, and Claude transcribes it (Plan, captions and the post need the words).
  // Split into sections stays (Plan uses the sections). op "undo": Clean it up anyway (also /rail op unimport).
  if (action === '/already-edited') {
    try {
      if (b.op === 'undo') { cleanUpAnyway(dir); broadcast(id, { t: 'files' }); return send(res, 200, projectView(id, dir)); }
      markAlreadyEdited(dir);
      broadcast(id, { t: 'files' });
      let started = true;
      try { await startStep(id, dir, 'transcribe'); } catch (e) { started = false; logEvent(id, { t: 'note', text: `Your edit is the cut. Transcribing didn't start: ${e.message}` }); }
      return send(res, 200, { ok: true, transcribing: started, ...projectView(id, dir) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/skill') {
    if (!/^[\w:-]+$/.test(b.skill || '')) return send(res, 400, { error: 'Bad skill name' });
    await chatFor(id).send(`/${b.skill} ${b.ask || 'for this project'}`.trim());
    logUse('skill.run', { project: id, skill: b.skill });
    return send(res, 200, { ok: true });
  }
  // Chat sessions (list, start a new one, continue an earlier one) and Compact.
  if (action === '/chat-sessions') {
    try {
      const chat = chatFor(id);
      if (b.op === 'new') chat.newSession();
      else if (b.op === 'open') chat.openSession(String(b.log || ''));
      return send(res, 200, chat.sessions());
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/chat-compact') {
    try { await chatFor(id).compact(); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/answer') {
    const ok = chatFor(id).answer(b.id, { allow: Boolean(b.allow), message: b.message, answers: b.answers, always: Boolean(b.always) });
    return send(res, ok ? 200 : 409, ok ? { ok } : { error: 'Claude is no longer waiting on that.' });
  }
  if (action === '/stop') return send(res, 200, { ok: chatFor(id).stop() });
  // The quick reply "Undo the change to …": Video Octopus puts the window's files back as they were before Claude's last reply.
  if (action === '/undo-turn') {
    try {
      const r = undoTurn(id, String(b.offer || ''), chats.get(id));
      // Claude's work put back is not a change for Claude either: the restored files are the package's starting point.
      markPackageBase(dir, { keepOpen: true });
      logEvent(id, { t: 'note', text: r.note });
      broadcast(id, { t: 'files' });
      return send(res, 200, r);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  // The step rail: the steps the page has seen done (the dock's green "done" moment), and Skip on an optional step
  // (Undo skip). A step the page sees done for the first time also gets one line in the chat log, "✓ <step> · <done
  // line>" with Show me, so the chat keeps it after a reload (once: the next page or tab already finds it seen). Not on
  // the first look at a project (nothing seen yet), so old steps don't fill the chat.
  if (action === '/rail') {
    const meta = projectMeta(dir);
    if (!meta?.type) return send(res, 400, { error: 'Pick a project type first.' });
    try {
      if (b.op === 'seen') {
        // Only steps that are done here count as seen, so a step reported early still gets its marker when it's done.
        const st = pipelineStatus(dir, meta.type, { lines: true });
        // Clean up's line counts what needs the creator, and work/prepare.json (written last) adds to that: while
        // Claude is still finishing it, its marker waits for that file or the end of the turn, so the line is final.
        const finishing = (x) => x.id === 'prepare' && chats.get(id)?.busy && mtime(join(dir, 'work/prepare.json')) < mtime(join(dir, 'work/joins.json'));
        const ids = new Set((st?.steps || []).filter((x) => x.done && !finishing(x)).map((x) => x.id));
        const now = [...new Set((Array.isArray(b.done) ? b.done : []).filter((x) => typeof x === 'string' && ids.has(x)))];
        const before = railSeen(id);
        setProjectState(id, { railSeen: now });
        if (before) for (const s of st.steps) if (s.done && now.includes(s.id) && !before.includes(s.id)) logEvent(id, { t: 'marker', done: true, step: s.id, text: s.name, line: s.line || '', show: s.show });
      } else if (b.op === 'skip' || b.op === 'unskip') setSkipped(dir, meta.type, String(b.step || ''), b.op === 'skip');
      else if (b.op === 'unimport') cleanUpAnyway(dir); // B9: "Clean it up anyway" on a step done by import
      else if (b.op === 'unfinished-ok') clearUnfinished(id);
      else if (b.op === 'tabs') {
        // What each tab had when the creator last looked at it (web/app.js tabNews): numbers only.
        const cur = state().projects?.[id]?.tabSeen || {}, next = { ...cur };
        for (const k of ['scenes', 'renders', 'cut', 'post']) if (Number.isFinite(Number(b.seen?.[k]))) next[k] = Number(b.seen[k]);
        setProjectState(id, { tabSeen: next });
        return send(res, 200, { tabSeen: next });
      } else throw new Error('Unknown rail action');
      return send(res, 200, pipelineStatus(dir, meta.type, { lines: true, seen: railSeen(id) }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/type') {
    if (!formats()[formatId(b.type)]) return send(res, 400, { error: 'Unknown type' });
    const old = projectMeta(dir);
    saveProjectMeta(dir, { name: old?.name || id, type: b.type, layout: old?.layout ? normalize(old.layout, b.type) : defaultLayout(b.type) });
    return send(res, 200, projectView(id, dir));
  }
  if (action === '/import') {
    try {
      if (!b.take || /[/\\]|\.\./.test(b.take)) throw new Error('Bad take');
      const files = receiveTake(id, dir, join(settings().recordingsDir, b.take), b.target);
      return send(res, 200, { files });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // Make what playback needs now (Make it now, or the page asking after its copies were deleted): demand brings back
  // copies deleted after an export when Optimise for editing is on.
  if (action === '/proxies') { makeProxies(dir, (ev) => broadcast(id, ev), { demand: true }); return send(res, 200, { ok: true }); }
  // This video's playback (the Media section): { mode: 'originals' | 'optimise' | null (follow Settings) }.
  if (action === '/playback') {
    if (b.mode != null && !PLAYBACK_MODES.includes(b.mode)) return send(res, 400, { error: 'Unknown playback mode.' });
    saveProjectMeta(dir, { playback: b.mode || null });
    appendWorklog(dir, `Playback: ${b.mode === 'optimise' ? 'Optimise for editing (720p copies)' : b.mode === 'originals' ? 'Keep originals' : 'as Settings › Storage says'} (${playbackMode(dir)})`);
    makeProxies(dir, (ev) => broadcast(id, ev), { demand: true });
    broadcast(id, { t: 'files' });
    return send(res, 200, playbackView(dir));
  }
  // Delete this video's 720p editing copies (after an export, or the Media section): for good, they are caches.
  if (action === '/playback-copies-delete') {
    const r = deleteCopies(dir, { all: b.all === true });
    if (r.files) appendWorklog(dir, `Deleted ${r.files} playback cop${r.files === 1 ? 'y' : 'ies'} (${(r.bytes / 1e9).toFixed(1)} GB); the originals in source/ stay`);
    broadcast(id, { t: 'files' });
    return send(res, 200, { ...r, copies: copiesSummary(dir) });
  }
  if (action === '/layout') {
    const layout = normalize(b.layout, projectMeta(dir)?.type);
    saveProjectMeta(dir, { layout });
    return send(res, 200, { layout });
  }
  if (action === '/export') {
    try { if (layersRunning(id) || audioRunning(id)) throw new Error('A layers or audio export is running for this project.'); return send(res, 200, startExport(id, dir, b, exportEmit(id))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/export-stop') return send(res, 200, { ok: cancelExport(id) || cancelLayers(id) || cancelAudio(id) });
  if (action === '/background') {
    try {
      if (b.op === 'use') return send(res, 200, { bg: useLibraryBackground(dir, b.file) });
      if (b.op === 'save') return send(res, 200, { saved: saveToLibrary(dir, b.file) });
      if (b.op === 'generate') {
        if (!String(b.prompt || '').trim()) throw new Error('Describe the background first.');
        await chatFor(id).send(generateBrief(dir, String(b.prompt)), { brief: { name: 'Generate a background' } });
        return send(res, 200, { ok: true });
      }
      throw new Error('Unknown background action');
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/autoframe') {
    try {
      const r = await frameCamera(id, dir, b.layer ? { file: (normalize(projectMeta(dir)?.layout).layers.find((x) => x.id === b.layer) || {}).file } : { main: true });
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/cut') return send(res, 200, await openCutEditor(id, dir));
  // Rename: the name Video Octopus shows (project.json); the folder keeps its name.
  if (action === '/archive') {
    if (chats.get(id)?.busy) return send(res, 409, { error: 'Claude is working in this project: wait for it or stop it first.' });
    if (packagingBusy(id)) return send(res, 409, { error: 'Codex is working in this project’s Packaging: wait for it or stop it first.' });
    if (exportInfo(id, dir).running || layersRunning(id) || audioRunning(id)) return send(res, 409, { error: 'An export is running for this project.' });
    const arch = join(projectsRoot(), '_archive');
    mkdirSync(arch, { recursive: true });
    let to = join(arch, id);
    for (let i = 2; existsSync(to); i++) to = join(arch, `${id}-${i}`);
    watchers.get(id)?.close(); watchers.delete(id);
    // The live chat stops with it: its process must not keep working (or be continued) in a folder that moved.
    // Its saved session, log and database rows stay under this id for a restore (ids are never reused).
    // On Windows its folder stays locked until the process has exited, so wait for that before moving it.
    const proc = chats.get(id)?.proc;
    chats.get(id)?.kill(); chats.delete(id); stepRuns.delete(id);
    killPackaging(id);
    await processExited(proc);
    await renameFolder(dir, to);
    return send(res, 200, { archived: to });
  }
  if (action === '/rename') {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return send(res, 400, { error: 'Give the project a name.' });
    // The creator's own name: automatic naming never touches it again (server/naming.mjs).
    saveProjectMeta(dir, { name, nameSource: 'manual' });
    return send(res, 200, { id, name });
  }
  // The record panel's script (web/prompter.js): script.md in the project folder, read back through /files/. Empty removes it.
  if (action === '/script') {
    const text = String(b.text ?? '').replace(/\r\n?/g, '\n');
    if (text.length > 400000) return send(res, 400, { error: 'That script is too long: 400,000 characters at most.' });
    const f = join(dir, 'script.md');
    if (text.trim()) writeFileSync(f, text.endsWith('\n') ? text : `${text}\n`); else rmSync(f, { force: true });
    return send(res, 200, { ok: true });
  }
  if (action === '/notes') {
    try {
      // The Cut tab replaces one cut item on every save: say so in the chat only when it first appears.
      const hadCut = b.field === 'cut' && (readJSON(join(dir, 'work/notes.json'), {})?.notes || []).some((n) => n.kind === 'change' && n.field === 'cut' && n.status === 'open');
      const doc = notesOp(dir, b);
      if (b.op === 'add' && b.kind !== 'change') logUse('scenes.note', { project: id });
      if (b.op === 'add' && b.field === 'cut') cutSaved(id, trimModes());
      if (b.op === 'approve') logUse('scenes.approved', { project: id });
      // A change landing in the package shows as a line in the chat, so the package is never a surprise.
      if (b.op === 'add' && b.kind === 'change' && !hadCut) {
        const n = doc.notes.filter((x) => x.kind === 'change' && x.status === 'open').at(-1);
        const k = doc.notes.filter((x) => x.status === 'open').length;
        if (n) broadcast(id, { t: 'note', text: `Added to the change package (${k} waiting): ${n.text}${n.scene ? ` · scene ${n.scene}` : ''}` });
      }
      return send(res, 200, doc);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/overrides') {
    try { return send(res, 200, setOverride(dir, b)); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // The Plan panel (B4): Approve plan (Plan the scenes is done, Build is next) or Ask for changes (the creator's words go
  // to Claude in the chat, as their own message, and the approval comes out until they approve the new plan).
  if (action === '/plan') {
    try {
      if (b.op === 'approve') {
        const approved = approvePlan(dir);
        keepInTurn(id, 'work/production.json', { approved }); // the creator's, even while Claude works
        // On a learned format this is also its plan approval (Script & learned format): one decision, not two.
        try { approveLearnedPlan(id, dir); } catch (e) { console.error('learned plan approval:', e.message); }
        broadcast(id, { t: 'files' });
        return send(res, 200, { ok: true, approved });
      }
      if (b.op === 'changes') {
        const text = String(b.text || '').trim().slice(0, 4000);
        if (!text) throw new Error('Say what should change in the plan first.');
        if (unapprovePlan(dir)) keepInTurn(id, 'work/production.json', { approved: undefined });
        try { unapproveLearnedPlan(id, dir); } catch {}
        await chatFor(id).send(`Changes to the scene plan: ${text}`);
        broadcast(id, { t: 'files' });
        return send(res, 200, { ok: true });
      }
      if (b.op === 'unapprove') { unapprovePlan(dir); try { unapproveLearnedPlan(id, dir); } catch {} broadcast(id, { t: 'files' }); return send(res, 200, { ok: true }); }
      throw new Error('Unknown plan action.');
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // "Apply my notes": the open notes (and new moves) go to the project's Claude as one message.
  // The Cut Editor just saved: bring the package's cut item up to date now (the file watcher would, a moment later).
  if (action === '/cut-sync') {
    try {
      // The edit itself (the cut as the editor opened it, and now): a direct edit decides the parts it touches.
      if (Array.isArray(b.base) && Array.isArray(b.segments)) markEdits(dir, b.base, b.segments);
      const r = syncCutItem(dir);
      cutSaved(id, trimModes());
      if (r?.created) broadcast(id, { t: 'note', text: `Added to the change package: ${r.item.text}` });
      return send(res, 200, notesOp(dir, { op: 'list' }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // A cut pulled in Scenes (One scene's cut lines, Whole video's trim lens): the one cut, saved like the Cut Editor does.
  if (action === '/cut-save') {
    if (cutReadOnly(dir)) return send(res, 409, { ok: false, locked: true, error: LOCKED_ERROR });
    try {
      const before = lockedCut(dir)?.segments || null;
      const r = saveCut(dir, b.segments, b.version);
      if (!r.conflict && before) markEdits(dir, before, b.segments);
      if (r.conflict) return send(res, 409, { ok: false, conflict: true, error: 'The cut changed in the Cut tab (or Claude changed it) after Scenes read it.' });
      if (r.created) broadcast(id, { t: 'note', text: `Added to the change package: ${r.item.text}` });
      return send(res, 200, { ok: true, version: r.version, ...notesOp(dir, { op: 'list' }) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/apply-notes') {
    try {
      // first: a scene to show as a short preview before the full render ("Show me scene N first").
      const first = b.first != null ? String(b.first) : null;
      // preview: what Claude would get, without sending (the package view shows it).
      if (b.preview) return send(res, 200, { ok: true, ...applyBrief(dir, { preview: true, first }) });
      // A cut change in the package: Video Octopus re-times the sheet, keyframes and notes to the new cut first.
      syncCutItem(dir); syncDocItems(dir);
      const retimed = retimeOnSave(dir);
      if (retimed) { broadcast(id, { t: 'note', text: `Re-timed to the new cut: ${retimed.files.join('; ')}` }); logUse('retime.done', { project: id, files: retimed.files.length }); }
      const brief = applyBrief(dir, { first });
      markPackageBase(dir); // the blocks and canvas look as Claude now has them
      setProjectState(id, { packageRun: brief.ids?.length ? { ids: brief.ids, at: Date.now(), started: false } : null });
      await chatFor(id).send(brief.text, { brief: { name: 'Save changes → Claude' } });
      logUse('package.sent', { project: id, items: (brief.notes || 0) + (brief.changes || 0) + (brief.moves || 0) });
      broadcast(id, { t: 'files' });
      return send(res, 200, { ok: true, notes: brief.notes, changes: brief.changes, moves: brief.moves });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // The scene timeline's "Update the scene kit": the project's copy of core/kit/octopus-scene.js, for keys and markers.
  if (action === '/kit-update') {
    try { const r = updateKit(dir); broadcast(id, { t: 'files' }); return send(res, 200, r); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (action === '/kit') {
    try { await chatFor(id).send(kitBrief(dir), { brief: { name: 'Set up the scene kit' } }); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  // Renders tab: mark one render as the final version (or unmark it).
  if (action === '/final') {
    const f = b.file == null ? null : String(b.file);
    if (f && !(/^renders\/[^/\\]+\.(mp4|mov|m4v)$/i.test(f) && existsSync(join(dir, f)))) return send(res, 400, { error: 'That render is gone.' });
    saveProjectMeta(dir, { finalRender: f || undefined });
    if (f) appendWorklog(dir, `Marked ${f} as the final render`);
    return send(res, 200, { finalRender: f });
  }
  if (action === '/reveal') { const f = inside(dir, String(b.file || 'WORKLOG.md')); if (!f) return send(res, 400, { error: 'Bad file' }); reveal(f); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'Unknown action' });
}

// The first launch makes the studio itself: ~/Video Octopus from the starter (projects and recordings inside), so the
// onboarding screen starts with the folders done. An install that has a studio, or has finished Setup, is left alone.
if (!settings().studio && !section('setup').done) {
  try { const r = createStudio(defaultStudioPath()); console.log(`Made your studio: ${r.shown}`); } catch (e) { console.error('first launch, the studio:', e.message); }
}
activateStudioSkills(); // recover interrupted transactions and publish matching skills before agents can start

const server = createServer((req, res) => {
  const pathname = req.url?.split('?')[0];
  // Routes that rebuild skills take the maintenance lock themselves (a counted write would block it).
  const write = pathname?.startsWith('/api/') && !pathname.startsWith('/api/app/updates') &&
    pathname !== '/api/app/skills/install' && pathname !== '/api/instructions' && !/^\/api\/learning\/(skills(?:\/|$)|backups\/[^/]+\/restore$|sessions\/[^/]+\/(approve|publish)$|formats\/[^/]+\/(activate|copy|update|archive|unarchive|skill)$|profiles\/[^/]+\/(update|archive|unarchive)$)/.test(pathname) && !['GET', 'HEAD'].includes(req.method);
  const finish = write ? beginWrite() : () => {};
  // An error with a status (a request body too large or not JSON, util.mjs) is answered with it; anything else is a 500.
  route(req, res).catch((e) => { if (!e.status || e.status >= 500) console.error(e); try { send(res, e.status || 500, { error: e.message }); } catch {} }).finally(finish);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Video Octopus is running: http://127.0.0.1:${PORT}`);
  // Where this Video Octopus answers, for bin/octopus.mjs (the command the Video Octopus assistant uses to act on the app) and for
  // every chat Video Octopus starts (they inherit STUDIO_URL).
  process.env.STUDIO_URL = `http://127.0.0.1:${PORT}`;
  // The command itself, for skills that ask the app to do something (e.g. Setup's model Download, after the creator's OK).
  process.env.STUDIO_OCTOPUS = join(APP_DIR, 'bin', 'octopus.mjs');
  try { writeJSON(join(LOCAL_DIR, 'server.json'), { url: process.env.STUDIO_URL, port: PORT, pid: process.pid, at: Date.now() }); } catch {}
  console.log(`Your studio folder: ${settings().studio || '(not set yet)'}  ·  projects in ${projectsRoot()}`);
  // The usage log's history, once, from the files already there (the Dashboard isn't empty on day one).
  setTimeout(() => { try { if (settings().studio) backfill(); } catch (e) { console.error('usage backfill:', e.message); } }, 1500);
  // Scheduled runs (server/schedules.mjs): catch up on any missed while Video Octopus was closed, then a timer.
  if (process.env.STUDIO_NO_SCHEDULES !== '1') setTimeout(() => { try { startScheduler(); } catch (e) { console.error('schedules:', e.message); } }, 3000);
  // A quiet look for a new version on GitHub, at most once a day (Settings → Updates; off there).
  startUpdateChecks();
});
// Stop everything Video Octopus started. Restart exits with RESTART_CODE, and start.sh / start.cmd start the server again.
const shutdown = (code) => { for (const c of chats.values()) c.kill(); killAssistant(); killLearning(); killProfileResearch(); killPackaging(); stopScheduler(); closeAll(); stopAllExports(); stopAllLayers(); stopAllAudio(); process.exit(Number.isInteger(code) ? code : 0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
