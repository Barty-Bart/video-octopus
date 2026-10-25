# v0.1.0-beta.23

- **Check my computer finds the Python you already have.** It now also looks for `.venv`, `venv` and `env` folders up to two folders deep in Movies, Documents, Downloads, Desktop, Developer, Projects, code, src and dev, one folder deep in your home folder, next to your studio, and in apps' data (`~/Library/Application Support` on a Mac, so OpenToolkit's speech environment shows up). It reads folder names only, never follows links, skips hidden folders, app bundles, photo and video libraries and node_modules, and stops after 1,500 folders, 2 seconds or 16 environments. The status line says exactly where it looked.
- **A best match with Use this.** Setup › Python environments puts the best environment first (Python 3.10+, NumPy and the most transcription engines; another app's own environment ranks after a project's) with **Use this**. You still confirm, and its imports are checked again before it is selected.
- **Nothing found? Ask the assistant to look.** When the scan finds nothing that can transcribe, one button asks your agent to search the whole computer read-only (Spotlight, `find` with a time limit, apps' folders, the Hugging Face cache). It installs, downloads and changes nothing; it reports what it found with `octopus python suggest`, the list refreshes by itself, and you choose with **Use this**.
- **Parakeet transcription.** With a selected Python that has `parakeet-mlx` on an Apple Silicon Mac, Settings › Transcription offers **Parakeet (on this Mac's GPU)** next to MLX Whisper and faster-whisper, and lists the Parakeet models already downloaded. The transcribe skill's `--engine parakeet` writes the same `words.json`, SRT and text: parakeet-tdt-0.6b-v2 for English, v3 for other European languages and Detect. It never downloads a model; Parakeet takes no spelling hints.
- **Auto prefers a good downloaded model.** large-v3-turbo is now a known Whisper model, and Auto no longer settles for tiny or small on one Whisper build when the other build already has a medium or large model. When your own pick is a tiny model and a better one is downloaded, Settings says so.
- **Prepare points to Setup, not to a new environment.** When no Python is selected, the agent's instructions and the skills use `$STUDIO_PYTHON` first and send you to Setup › Python environments before ever offering to create a new `.venv`.
- **No waiting for playback copies.** A new take or imported file plays on the canvas, in the Cut Editor and on the timeline straight away. The full-width "Getting your recording ready" screen is gone; when Video Octopus is still working on a file, a small status next to the time says so ("Making a 720p editing copy · 34%", "Indexing for seeking"), and the picture switches by itself when it's done, keeping your place and playing on. Transcription, Clean up and export never waited for the copy and still don't.
- **Keep originals or Optimise for editing.** Settings › Storage › **Playback** picks what the editor plays. **Keep originals** plays your own files, so no second copy takes up space (a 67-minute 1440p take had 3.7 GB of copies). **Optimise for editing** makes the 720p copy as before, for smooth scrubbing, and plays the original until it's ready. Each video can choose for itself in the Media section. Keep originals is the default on a Mac, where the recorder's files seek in about 17 ms at 1440p; on Windows and Linux the recorder's files have far fewer keyframes, so Optimise is the default there.
- **Originals stay originals.** With Keep originals, a file the browser can play but can't seek in well (a browser recording saved as a fragmented MP4, an MP4 or MOV with its index at the end, a WebM without an index) is re-indexed in place once: the same audio and video, copied as they are with nothing re-encoded, into a temporary file that replaces the original only when it's complete and checked. A 12-minute 2.4 GB file takes about 2 seconds. If anything goes wrong, the original stays exactly as it was. Only a file the browser can't play at all (PCM sound in a .mov, HEVC, ProRes) gets a 720p copy, and the editor tells you why.
- **Slow-seeking files are flagged.** When a file has a keyframe only every few seconds, so jumping around it is slow however it's indexed, the Media section says so and suggests Optimise for editing for that video.
- **Delete the copies after an export.** After an export, if the video has 720p editing copies, Video Octopus asks "Delete the 720p editing copies (3.7 GB)? Your originals and the export stay." **Delete** removes them for good, not to the Bin, because they are only caches that can be made again. **Keep** leaves them. **Don't ask again** turns the question off (Settings › Storage › Playback turns it back on). If you edit the video again with Optimise on, the copies are made again in the background. Settings › Storage › Playback also lists the space copies use in each video, with **Delete all copies**.
- **Exports are always full quality.** As before, every export reads the original files in `source/`, never a 720p copy, in both modes. A new test now checks this.
- **Smoother copies on Windows and Linux.** A 720p copy now has a keyframe every 15 frames. In Chromium that takes scrubbing a 10-minute copy made on Windows or Linux from 9 to 22 frames a second up to 60.

Verified with 507 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, one real Parakeet run on this Mac with cached models (English on v2, Detect on v3), seek measurements on 10–12 minute synthetic 1440p files, and disposable browser runs with fake agents (Setup's best match and the ask button, Parakeet in Settings, playing originals with a copy landing mid-play, the delete-copies card after export). Not run: Windows or Linux natively, and a real agent's whole-computer search. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.22

- **Dropped files are in Recordings.** A video file you drop or import into a video now shows in **Recordings** next to your takes, marked **Imported**, named after the original file ("Screen Recording 2026-10-24 at 10.02.11.mov") and with the video it's in. It is listed where it already is, in that video's `source/` folder: nothing is copied a second time. Files imported before this update show up too, by their original name when the video's WORKLOG says it, else by the file's name. **Open video** goes to the video.
- **Deleting an imported file works like a take.** **Delete** in Recordings, and **Delete recording** in the editor's Media section, ask the same question. **Remove from this video** keeps the file: it moves to the recordings folder, so it stays in Recordings and you can use it again (Undo puts it back in the video). **Delete recording** takes it out of the video and out of Recordings and moves it to your computer's Bin (the studio's trash when there is no Bin), with Undo. Both are refused while Claude or an export is using the video's files.
- **Start a video from an imported file.** Once a file is back in Recordings on its own, **Start a video from it** moves the file into the new video instead of copying it, so it is never in two places.
- **The way back to Projects is always there.** In the editor, the top bar's logo now reads **‹ Projects** and takes you to the Projects page (it was the logo alone since beta.19). The bar itself can no longer go missing: when a page failed to load (Settings while the app restarted, for example), it left its page classes behind and the next video you opened had no top bar at all, so no logo, name, style picker, stage bar or way home. Every page now starts clean, and the editor's bar shows whatever page came before.
- **No sideways scroll in the editor on a phone.** The stage bar folds into its one-button form by the same 760 px breakpoint as the layout, so an overflowing page can no longer keep it wide.

Verified with 481 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and disposable browser runs with fake agents and a fake Bin (Recordings with imported files at 1440 and 375, both delete answers, Undo, Start a video from a removed file; the editor after a failed Settings load at 2000, 1440 and 375). The phone stage-bar fold is unit-tested only. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.21

- **One next step.** The dock above the message box is the only place that says what's next, and everything else agrees with it. Projects names the dock's step (a finished video with only an optional step left says "Done · Next: Package (optional)"). The Cut panel's **Save and lock the cut** is the big button only while Lock is the next step; before that it says the dock's step comes first, and it no longer promises that planning the scenes comes next. The Blocks band offers **Split into sections** only while that is the next step. A new video's chat offers **Outline a script** and **Give me 5 hooks** while Record is next ("Before you record…").
- **Running a step takes you there.** Press **Run** in the dock, in an empty page or in a stage's ▾ list and the editor opens the step's stage as it starts: Clean up opens Cut, Plan the scenes opens Plan, Build the intro opens Build. A step Claude starts from the chat doesn't move you, nor does Run pressed inside a panel (the Blocks band, the Cut panel's Lock), nor being on that stage already.
- **One Research button.** On a brand kit's **Brand** tab, give the website and press **Research**: it makes the research session and starts it in one go (there is no separate Create step). The session then shows only the button its state needs: **Stop research** while it runs, **Resume research** if it stopped early, **Review proposal** when there is one to review.
- **No black "To review" tiles after a partial build.** When the render shown in Scenes covers only part of the video (Build the intro), the scenes it doesn't reach say **Not in this build** on a quiet striped picture instead of a black thumbnail marked "To review", and the list's legend counts them. A scene no render reaches still says **Not built yet**, once.
- **Claude's own work is not a change package.** The change package is only for your edits. When Claude splits the video into sections, changes the layout or the blocks in a reply, or Video Octopus places a rule block by itself, that applies straight away and never shows up as "1 change waiting" or "Save changes → Claude · 1". Claude's reply or step shows in the chat with **Undo**: a reply as before, and now also **Split into sections**, **Plan the scenes** and the post kit ("Undo Split into sections"), one level back, until the next turn.
- **A locked cut looks locked.** After **Lock the cut**, the Cut tab is read-only: a banner says **Cut locked · Unlock to edit**, the transcript and waveform can be played and selected but not cut, the flagged-join marks and the "Joins to check" count go away, and Keep / Cut in the list are off. Scenes' cut trims wait for the unlock too. **Unlock to edit** (on the banner or in the inspector) is the only way back: the cut becomes editable, the Lock step is no longer done and **Lock the cut** is the next step again (WORKLOG.md says "Cut unlocked"). Editing no longer undoes a lock silently in the Cut tab; a change Claude makes to the cut from the chat still does.
- **Plan has Approve.** When Claude has written the scene plan, the Plan stage's panel opens on **Plan**: every scene with its line and what's on screen, **Approve plan**, and **Ask for changes** (what you type goes to Claude in the chat; it changes the plan and stops). The dock says **Next · Approve the plan** until you approve, and only then is the Build step next. Asking for changes after approving takes the approval back until you approve the new plan. Only you approve: an "approved" Claude writes into the plan is taken out again. Videos that were already built before this update count as approved. Approving a scene in Polish is unchanged and still needs that scene built.
- **Polish: Approve is always on the scene.** **Approve scene** sits over the picture next to the scene's name, whichever panel tab is open (it's no longer under Notes). A scene no render has built shows it greyed out as **Build first**.
- **Claude finished, in words.** When Claude's turn after **Save changes → Claude** ends, the Scenes panel and the chat say what came of what you sent: "Claude finished · 2 notes done, 1 still open". A note Claude left as sent says "1 note not marked done", so you know to check it.
- **Footage you already edited.** Drop or import a video file into a new video and Video Octopus asks **Is this video already edited?** **Yes, it's my edit**: the whole file is the cut, Claude only transcribes it (for the plan, captions and the post), and **Clean up** and **Lock the cut** are done ("Done · already edited" in the Cut stage's steps). **Split into sections** is next, then **Plan the scenes**. **Clean it up anyway** in that list makes them steps to do again. **No, tidy it up** works as before. Recordings made in Video Octopus are never asked.
- **See the take while you record.** While a take records, the editor's canvas shows it live instead of "How do you want to start?": the screen with your camera in its corner (or the camera alone), the mic level and the time, with the recording bar (Pause, Restart, Stop) under the picture. After **Stop** it says **Saving the take…** until the take is in the video. The Media section says **Recording now** instead of "No recording yet".
- **The idea carries into the script.** In Packaging, **Use this idea** (on the main thumbnail, in its Winners slot, or in any card's ⋯ menu) puts a short outline into Record's script: the working title, what you said the video is about, the card's idea, and its hook and three beats when it has them. A script that already has words is never replaced: you're asked, then the outline goes under it, or nothing changes. The project chat then offers **Ask Claude to outline it** (it only sends that message). An empty Packaging board has a big **Generate 6 ideas** with a box for the idea and its cost (one generation on your ChatGPT plan).
- **Claude's state, the same everywhere.** Four states, shown alike in the editor's top bar, on the dock above the message box, as a small mark on the folded chat and in the tab title: **Working** (any turn now, a plain message too, not only steps; the title gets a quiet ◌), **Waiting for you** (the title keeps **● Waiting for you**; the request itself still shows once, as the banner in the chat), **Claude finished · N still open** (Claude's last reply asks you something, a step didn't finish, or notes it left open; the title gets the count), and **Claude stopped** with **Send again** right on the dock (the title gets !). The top bar's badge opens the chat where it matters. Packaging's chat counts too, as Codex.
- **"Claude finished · 1 still open" everywhere.** When the turn after **Save changes → Claude** ends with notes Claude left open or didn't mark done, Claude's state is "finished with open items" in the top bar's badge, on the dock ("Claude finished · 2 notes done, 1 still open · Read ×"), as the mark on the folded chat and in the tab title ("(1) …"). **Read** opens Scenes' Notes on the first scene with one open; it goes away by itself once you deal with those notes, or with ×. A reply that asks you something now reads the same way ("Claude finished · 1 still open").
- **The dock while you record.** During a take the dock says **Recording 0:42 · Stop** (or **Paused**, then **Saving the take…**) instead of offering Record · Start again, and Stop there ends the take. Running the Record step during a take no longer reloads the take list behind the live view.
- **The top bar keeps its room.** When the bar is short of room (a long style name at 1440 px, or narrower windows), Claude's state badge folds to its dot, with the words in its tooltip, instead of squeezing the style picker; the Record button's ⌥⌘R hint steps aside while the badge shows.
- **One plan approval on a learned style.** On a video made with a learned style, **Approve plan** in the Plan stage is also the style's own plan approval (the one in Script & learned format), and approving there also approves the plan in the Plan stage. Approving the plan or Claude marking scenes as built no longer makes it go stale; changing a scene or the locked cut does, and then the dock says **Approve the plan** again ("Approve plan again" in the Plan panel) instead of Build failing with an error.
- **Build shows progress per scene.** While Claude builds, it marks each scene in the plan as it starts and finishes it, one command per scene (the production-sheet skill's `sheet.py mark`, skill 1.2.0). The dock says **Build the visuals · scene 3 of 10**, the Scenes list marks each scene **Queued**, **Building…** (with a spinner) or **Built** and its header counts "Building · scene 3 of 10", the scenes outside this build say **Not in this build** (the body during **Build the intro**), and the timelines' Scenes lanes underline built and building scenes. A one-scene preview render counts as that scene built. If Claude doesn't mark scenes, the dock shows how long the step has run, as before.

Verified with 468 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and disposable browser runs with fake agents, including one pass through the main journey (record with the live view, already-edited drop, Clean up → Cut, Lock and Unlock, Split into sections with Undo, Plan → Approve, Build with per-scene progress, Polish notes → "Claude finished", Packaging → Use this idea, a permission wait). Real agents and the Playwright e2e suites were not run. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.20

- **Every brand kit has a colour.** A kit uses its brand's first colour; a kit without brand colours gets its own colour from a palette of twelve, picked when the kit is made, different from the other kits' where possible. Kits made before this update get one the first time the studio opens. Change it on the kit's **Brand** tab under **Kit colour** (twelve swatches or any colour). The kit colour is only for covers, dots and avatars: it is never added to the brand or to videos.
- **Style covers that look like covers.** A style's card shows a picture when the studio has one: the main thumbnail from Packaging of a video made with the style, else a frame of that video, else a key frame of an example the style studied. Otherwise the cover is drawn in the kit colour, with the style's initial and a 16:9 or 9:16 frame showing a presenter (on-camera setups) or a waveform with captions (faceless). No brand styles get a colour of their own. The style page's cover matches.
- **Filled dots.** The brand kits bar, the cards' kit chips and the editor's style picker show each kit's colour; No brand has no dot.
- **A tidier My styles page.** Cards are a little smaller, with room between them; **New style** is as tall as a card; Studio instructions and Memories for everything are two quiet rows under "Shared by every style".
- **Delete a recording for real.** **Delete recording** in the editor's Media section now asks one question with two answers. **Remove from this video** works as before: the files go to the studio's trash, the take stays in Recordings, Undo brings it back. **Delete recording** removes it from this video and from Recordings and moves the files to your computer's own Bin: the Trash on a Mac (through Finder, so Put Back works; if Finder isn't allowed, macOS's `trash` command or a move into `~/.Trash`), the Recycle Bin on Windows (fixed drives only). The toast says where it went, with Undo for a few minutes. Tick **Don't ask again** to make it one click; **Settings › Storage › Trash** changes it. Older takes in **Also in this video** have **Delete recording…** in their ⋯ menu too.
- **Recordings' Delete** sends the take to the Bin as well. If a video uses the take, it names the videos and asks first; each video keeps its own copy, so nothing in them changes.
- **Still never a hard delete.** When there's no Bin to use (another disk, Linux, or the Bin refused), the files stay in the studio's trash and the toast says so. Delete is still refused while the take is recording or saving, while Claude, Packaging or an export is working, and once a transcript, cut, scene plan or render was made from the recording. This replaces beta.18's "your recordings folder is never touched": **Remove from this video** still never touches it. **Delete recording** is the one action that does, and only when you choose it.
- **Model and effort in the chat.** Next to the permission mode, the chat has a **Model** and an **Effort** picker for this video: Claude Code's model and effort, Codex's model and reasoning effort, pi's model and thinking level. **Default** follows **Settings › Agent & model**, which now has the studio-wide effort too. A change applies from your next message. A picker the agent can't use there stays hidden (another model source, a local model, an endpoint).
- **Never miss a permission request.** When the agent waits for your answer, a banner at the top of the chat has **Allow**, **Always for…** and **Deny** right there. The editor's top bar shows **Waiting for you**, and the tab title starts with **● Waiting for you**. The banner can turn on desktop notifications (asked once) and a short sound. Packaging's chat, study chats and the assistant show the banner too; the Library assistant uses the title and notification.
- **Record starts the way your style records.** The sources start from the style's setup. Faceless starts with the screen on and the camera off. Short / Reel starts camera only with no screen. On camera and Product explainer start with both. What you change is remembered for that style, and a line over the sources says which. **Screen** is now a plain **On / Off**, with **Choose window…** only when it's on.
- **Permission requests show once.** The banner at the top of the chat is where you answer: it names the tool and what it's for, **Details** shows the command, or the file (from the video's folder, or `~/…` outside it) and a small diff of the change, and it has **Allow**, **Always for…** and **Deny**. The chat no longer repeats it as a card; once answered it keeps one line ("Allowed: Bash · …", "Denied: …"). The same in Packaging's chat and study chats. Questions still show their options in the chat.
- **An agent that can't start no longer stops Video Octopus.** If Claude Code, Codex or pi quits as soon as it starts (for example installed but not signed in), the server stays up and the chat says what to do, e.g. "Claude Code isn't signed in. Open Terminal and run claude, then Send again."
- **Send again.** When the agent stops mid-turn ("Claude Code stopped (exit 3)"), the message has **Send again**: your last message or step goes again, without a second copy in the chat.
- **Sign-in and ffmpeg warnings with their fix.** The "not signed in" notice has **Check again** and shows in the editor too. Without ffmpeg, Projects and the editor say so with a link to **Setup → Tools**, and starting a video from a take no longer stops the server. Setup's Python row has **Fix** when the Python is too old.
- **Clearer waiting.** While a step runs, the empty Plan, Cut, Renders and Post pages say "Clean up is running · waiting for you in the chat" (with **Answer in the chat**) instead of offering to start it again.
- **Delete take asks instead of refusing.** The record panel's **Delete take** asks first when another video uses the take or it already has a transcript or cut, then goes ahead (with Undo). Every delete question links the videos it names, and the reason is never cut off.
- **Projects.** A finished video says **Done**, not the optional Package step. A 9:16 Short's cover shows whole instead of cropped to 16:9.
- **Stage bar.** **Publish** gets its tick once the video is exported or a render is marked final, not when a Build step renders. Show me's "New · from …" outline goes away when you switch stages instead of sitting over the logo. The bar always shows the open video's own progress.
- **One count for your changes.** The dock and the Scenes panel say the same number for "Save changes → Claude".
- **Small fixes.** The chat's brand line follows a newly picked style at once. The mic meter holds its peak, so "Too loud" never shows over an empty meter. The New style dialog keeps **Create** in view on a short window. At phone width the Cut transcript is readable (full width under the picture). An unbuilt scene says "Not built yet" once. Codex's step lines say "What Video Octopus asked Codex", and a turn that hit the plan's limit ends "stopped: limit reached". A dropped screen recording (named as one) comes in as the screen, not a camera. When a step finishes without its result, the dock says what's missing ("Build the intro didn't produce its video.") instead of Claude's last sentence.

Verified with 426 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and disposable browser runs with fake agents (My styles in light and dark at 1440 to 375 px; delete to the Bin with fake Bin commands; model and effort flags reaching a fake Claude Code; the permission banner; Record presets; before/after checks for the walkthrough fixes). The real Finder/Recycle Bin calls and the Playwright e2e suites were not run. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.19

- **Room for the stages.** The editor's top bar shows the logo alone, a narrower name and style picker (hover either for the whole name), and the plan-usage meter as two small bars (hover for the numbers). The Light/Dark switch moved to the bar's **⋯** menu (Settings › General › Theme still has Match system). With a long style name and the meter showing, the whole bar (segments and ▾) fits at 1440 px; at 1280 px only the segments go; at 1100 px the ▾ go too (Alt+↓ or a long press still opens a stage's steps); the one-button stage menu remains for 760 px and below.
- **No sideways scroll on a phone.** At 375 px the canvas transport and the timeline's buttons wrap instead of widening the page.
- **Settings › Storage › Trash.** See what deleted takes and removed media are in the studio's trash, their size, and **Put back** each one (refused if something with the same name is back, if its video is gone or archived, or while its video is busy). **Empty trash…** and **Delete items older than 30 days…** are the only permanent deletes in Video Octopus: each asks first, says how much goes and that it can't be undone. Nothing is ever emptied automatically.
- **Delete in Recordings.** Each take has **Delete** (to the trash, with Undo). It's refused while the take is still recording or saving, and when a video uses it (the message names them).

Verified with 381 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and a disposable browser run (54 of 54 checks: the header at 1440, 1280 and 1100 px with a long style and the meter, no sideways scroll at 375 px in the editor, Settings and Recordings, every Trash and Recordings path in light and dark). This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.18

- **Media in every video.** The Canvas inspector starts with a Media section, and a **Media ▾** button sits in the canvas toolbar.
  - **Current recording:** **Record again** (replaces the take) and **Delete recording**.
  - **On the canvas:** every layer top to bottom; drag the grip (or focus it and use ↑/↓) to reorder; the eye shows or hides a layer; extra layers have Sound, Take off the canvas and Remove.
  - **Also in this video:** older takes and imported files kept in the video's `source/` folder, each with **Use**, **Add as a layer** and **Remove**.
  - **+ Add a layer:** record a new take, import a video file, or pick a recording.
- **Nothing is lost.** Delete and Remove move the video's files (and their playback copies) to the studio's `.trash` folder; **Undo** and **Put back** (last three) restore them exactly. Your recordings folder is never touched. After deleting the current recording, the video returns to its previous take, or to "How do you want to start?" if it was the only one.
- **Safe by default.** Delete and Remove are refused while Claude, Packaging, an export or a playback copy is working, and once a transcript, cut, scene plan or render was made from that recording; it asks first if renders were made while it was in the video.
- A take's files are now matched exactly (a take no longer picks up a similarly named "-2" or "(2)" file).

Verified with 371 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and a disposable browser run with synthetic takes and the real recorder (36 of 38 checks; the two failures are an existing sideways scroll at 375 px from the transport's volume slider and the timeline help button). The trash is never emptied automatically yet. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.17

- **Click a stage to open its workspace.** The stages in the editor's top bar are now its tabs: Package → Packaging, Record and Build → the canvas, Cut → Cut, Plan → Scenes, Polish → Scenes at the first scene with open notes, and a new **Publish** stage with your renders and the post (title, description, captions) in one pane. The separate tab row is gone; a slim toolbar over the workspace keeps its name, its tools and Finder.
- **Where you are vs. how far the video is.** The stage you're on is bold and underlined; a **NEXT** badge marks the stage of the next step, or **RUNNING** with a spinner while Claude works on one. Switch stages any time, even while a step, the chat, an upload or an export runs: nothing stops, and each pane keeps its state. Click the RUNNING stage to go back.
- **Each stage's steps** (Run, Skip, Show me) are behind the small ▾ beside it (or Alt+↓). Show me opens the stage that owns the step. "New" dots moved from the tabs onto the stages.
- **Links and reloads** keep the stage in the address (`#/p/<video>?stage=cut`), and each video remembers the stage you last used. Old `?tab=` links and the old remembered tab land on the matching stage.
- **Narrow windows** fold the bar step by step; at 760 px and below it is one button with the current stage that lists every stage.
- The Record button says **Paused m:ss** while a take is paused.

Verified with 357 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and disposable browser checks (every stage, switching while a step runs, reloads and old links, light and dark at 1440 to 375 px). Known: with the usage meter showing, the header is tight below about 1440 px, so the bar folds earlier. This is a source update on main; the downloadable tagged prerelease remains separate.


# v0.1.0-beta.16

- **Pause and resume while recording** (⌥⌘P; Ctrl+Alt+P on Windows). Every recorder pauses, the timer stops, and the teleprompter pauses with it; the saved take leaves the pause out.
- **Restart a take** (⇧⌥⌘R; Ctrl+Alt+Shift+R). It asks once ("Restart? This take will be discarded."), throws the half-take away (to the studio trash, never as a take), counts down 3 s and starts again with the script back at the top.
- **Delete take**, offered for 15 seconds after a take is saved: the take's files move to the studio's `.trash` folder and the video goes back to its previous take; Undo restores everything. It refuses if another video uses the take, if a transcript, cut or render was already made from it, or while still recording.
- **Teleprompter buttons.** Play/pause, speed up/down and text size bigger/smaller are now real buttons (with their keys in the tooltip) in the practice run, while recording and in the script's own window. All keyboard shortcuts still work.

Verified with 345 unit tests on Node 24.22.1 and 22.22.1 and a disposable browser run with real recording, uploads and file moves (Chromium's fake camera and mic and the app's test picture for the screen). Not exercised: the native screen picker, Windows. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.15

- **My styles is flat.** Each style is one kind of video (for example "Faceless reel" or "YouTube tutorial") shown as a card you click straight into. A style's page has one row of tabs: Skill (rules and Talk to this style, with skills, files, insights, history and videos alongside), Examples, Brand, People & places, and Memories.
- **Brand kits.** Brand, website research, assets, people & places and memories live in brand kits, shown in a bar above the styles and at My styles › Brand kits. A style uses one kit; **Change kit** moves it to another (or to No brand) while videos already made keep what they were pinned to, and the style's conversations follow the new kit's memories. A kit still used by styles can't be archived.
- **New style** asks what kind of video it is and which kit to use; New video and the editor's style picker show the same flat list. Styles without a brand use a hidden built-in "No brand" kit.
- **Old links keep working,** including beta.14's style addresses and every earlier channel link.
- Under the hood nothing moved: styles are formats and kits are the existing profiles.

Verified with 334 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and 233 disposable browser checks (light and dark at 1440, 980 and 375 px). Not run: e2e suites, Windows UI. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.14

- **Themes.** Appearance is now Light, Dark or Match system, with four accent colours (orange, blue, green, violet), replacing the ten looks. Your previous look is mapped automatically on first start (light looks → Light, dark looks → Dark, the default → Match system) and a one-time note says so. A light/dark switch sits in page headers. Unused looks and font families were removed.
- **Sidebar.** A slimmer rail you can collapse to icons (remembered), with Projects, Recordings, My styles and Tools; **Ask Claude** is a rail button (⌘J) instead of the floating pill.
- **Projects home.** A Continue banner with a real frame from your latest video and its next step, a "waiting for you" strip, and large thumbnail tiles you can filter by style.
- **Styles.** What were channels are now called styles throughout the app (My styles, each with Formats · Brand · Memories). Old links keep working. Styles can have a short description.
- **New video opens straight away** as "Untitled video" with your last style and format, and asks how to start: Record now, Drop footage, or Idea & thumbnail first (Packaging). Switch style or format from the editor's top bar (after Build, only formats with the same video setup). Claude names the video once you describe it, or your Packaging working title does; a name you set yourself is never replaced.
- **Settings** in six groups (General, Agent, Recording, Editing & sound, Export, Storage) with search; old settings links land in the right place.

Verified with 327 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, and disposable browser checks in light, dark and system at 1440, 980 and 375 px. Not run: e2e suites, Windows UI, real-provider naming. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.13

- **Packaging (first version).** An optional **Package** stage comes first on each video's rail and never blocks the rest. Its Packaging tab has a Codex chat (on your ChatGPT plan) that knows the video's memories and resources.
  - **Generate** asks Codex for one image with six thumbnail ideas in a 3 × 2 grid and cuts it into six cards; the reply's lines name them.
  - **Refine** turns a card into a 1280 × 720 thumbnail.
  - The board lets you star ideas, pick up to three winners and one main thumbnail (which completes the Package stage), and upload old thumbnails.
  - A working title fills the Post tab's YouTube title only when it is empty.
  - Titles and hooks are shown as coming soon.
- **Resources.** Photos, logos, colours and notes at All channels, Channel or This video, managed in the channel's Brand tab and in Packaging. Each photo says who is in it; photos of someone else are never sent to an image model. Resources are live: new ones reach videos already in progress.
- **Isolation.** The Packaging chat runs read-only in the video folder with only the studio's context: your own Codex hooks and memories, MCP servers, plugins and web search are switched off for it (scheduled Codex runs now switch off hooks and memories too). Read-only commands don't ask; anything else still does.
- **Limits.** If Codex's image allowance runs out, Packaging says so and shows when it resets.
- **Groundwork.** One shared scope ladder (All channels › Channel › Format › Video) for memories and resources; brand assets moved into the file store (backed up first, verified, resumable); Storage and restore count Packaging and resource images as in use.

Verified with 302 unit tests on Node 24.22.1 and 22.22.1 and a fake Codex app-server, plus one real Codex test on a ChatGPT plan (2 generations: a 2048 × 768 sheet cut into six cards, and a refined 1280 × 720 thumbnail; usage meter and `resetsAt` as expected). Not yet verified with a real photo of a person as a likeness reference. Requires Codex signed in with a ChatGPT plan. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.12

- **Pinned format skills hold.** A video's pinned copy of its format skill now has its own name (`format-…-v<N>`), and every studio format skill is switched off in pinned project chats and scheduled runs, so a newer approved version can't replace the one a video started with. Existing pinned projects get the renamed copy on their next chat; any older copy is kept aside, never deleted. Verified with a real Claude Code run as well as Codex and pi test adapters.
- **Workflow check.** When a draft changes or removes a rule but keeps the old workflow, the review shows a warning with the lines that still mention the old behaviour. The format conversation is also asked to update the workflow itself.
- **Only your own skills are listed.** Format conversations and brand research are told only about the format skills they can actually use.
- **Brand tab.** Approving, saving or restoring a brand updates the tab, the channel avatar and the sidebar at once, and the research status updates while it runs.
- **Phones.** The floating Ask Claude button no longer covers dialog buttons or chat send buttons.

Verified with 289 unit tests on Node 24.22.1 and 22.22.1, the format-skill (14 checks) and learning runtimes, disposable browser checks, and a real Claude Code check that a video pinned to v2 loads only v2 after v3 is approved. Codex and pi are verified with test adapters only. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.11

- **New layout.** A grouped sidebar: New video; Make (Projects, Recordings); My style (All channels and one row per channel, with a dot when memories await review); Assets (Library); Automation (Skills, Scheduled); Settings. On narrow windows the sidebar becomes a drawer.
- **Channel hub.** Each channel has Formats (its formats, format home, skill and Talk to this format), Brand (its brand profile) and Memories tabs. All channels lists every channel, the studio instructions and Everything memories. Projects can be filtered by channel and show their channel and format; New video can start from a channel.
- **Skills** is a list with on/off switches and a detail panel. **Settings** gains Usage (formerly Dashboard) and Storage & backups; Brand profiles and Instructions moved to the channel hub and All channels.
- **Old links keep working.** Earlier addresses for Video formats, Memories, Storage, Dashboard and Settings › Brand/Instructions redirect to their new places.
- **Memory levels.** Memories have two visible levels, This channel and Everything; the channel wins on the same topic. Lessons the agent proposes go to the chat's channel by default, and you choose "Keep for" when approving or in Remember this. Older video- or format-level memories keep working and can be moved to their channel. A channel's memories never reach another channel.
- Styling of the new screens uses theme tokens only (checked by a test) and works across all looks.

Verified with 282 unit tests on Node 24.22.1 and 22.22.1, the format-skill and learning runtimes, route-redirect tests, and disposable browser checks at desktop, 980 px and 375 px in several looks. Not verified: brand research inside the Brand tab, real-provider runs, Windows UI. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.10

- **Skill files.** A format's skill can hold real files: assets (backgrounds, icons, images, motion files) and knowledge (product sheets, specs, price lists) with an index in SKILL.md. Files live once in a content-addressed store in the studio (`.studio/files/`); SQLite keeps their records; skill folders get copy-on-write copies. Up to 300 files per skill, 1 GB each. A Files tab stages additions and removals into the next reviewed version. Storage lists unused files, deletes them on request (never one a version uses) and backs the file store up to a folder.
- **Migration.** Existing studios move asset and key-frame bytes out of SQLite automatically after a database backup; it resumes after interruption and is safe to repeat. An older app version cannot read migrated skill files without restoring that pre-migration backup. Back up the database and the file store together.
- **Runtime.** Requires Node 22.16+ on 22.x or 24+ (Node 23 and 22.13–22.15 lack the SQLite full-text search memories use). Startup checks it and explains what to install. Setup and Updates warn (without blocking) when Node is older than the October 2026 security releases (22.23.4 / 24.22.1) or FFmpeg is older than 8.1.2, because the app processes downloaded example videos.
- **Agent context.** Claude and pi receive the app's system prompt through a file, keeping command lines short on Windows. Scheduled runs on a pinned project use its pinned brand, format and skills. Agents are told their real working folder. Format conversations see only their own format skill and brand research none. Install-wide brand lines no longer contradict channel profiles; Settings says Instructions apply to new videos.
- **Projects.** A format upgrade into another channel is refused before anything is saved, and projects broken by it earlier get Repair project setup. Upgrades keep the project's brand and memories and show the change. Archived project ids are never reused, so a new project with an old name starts clean.
- **Reliability.** A hand-edited generated skill is restored with the edit kept aside instead of blocking chats; rebuilds skipped while an agent was busy run when it is idle. Codex and pi start failures are reported as errors; switching provider starts a fresh session; pi's Auto mode writes only inside the project. On Windows the selected Python path reaches agents correctly. On Windows, archiving or restoring a project waits for its agent process to exit and briefly retries the folder move instead of failing with EBUSY.

Verified with 267 unit tests on Node 24.22.1 and 22.22.1, isolated format-skill (13 checks) and learning runtimes, a before/after agent-context probe for every fixed defect, and disposable browser checks. Real-provider runs (including Claude honouring `claudeMdExcludes`/`skillOverrides`) and Windows execution are verified only by the CI matrix where covered. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.9

- Video formats is three panes: channels, their formats, and a format home with New video and tabs for Skill, Examples, Insights, Videos and History. Channels and formats can be renamed, have their setup changed and be archived or restored.
- Each format has one generated skill (rules, workflow, examples with notes and key frames, assets, insights and the videos made with it), rebuilt from SQLite. New videos keep the version they started with; Claude, Codex and pi load the pinned copy.
- Talk to this format: one conversation panel for studying new examples (paste links or drop files) and for plain-language changes such as "use blue instead of red". Conversations continue after a version is saved. Every change is a draft marked New, Changed or Removed and is saved as the next version only after review. Rules can also be edited directly.
- Draft evidence is checked: studied examples, the creator's own chat message, or a direct edit. New per-version `learned-*` skills are no longer published; existing ones are left in place.
- Reliability: request bodies are decoded whole (no split characters) and too-large or malformed requests return 413/400 instead of saving nothing; settings and other app state are written atomically, and a damaged file is set aside rather than replaced with defaults.
- The status chip, sidebar card and Projects notice describe the selected agent (Claude Code, Codex or pi). Unit tests run in GitHub Actions on macOS and Windows with Node 22.13 and 24.

See [formats and storage](learning-and-storage.md) and [format research](format-research.md). Verified with 232 unit tests, an isolated format-skill runtime (study → v1 → chat edit → v2 with an older project still pinned to v1) and disposable browser checks. Real-provider studies, real file drag-and-drop and Windows execution of these changes remain unverified. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.8

- Video formats shows all saved formats grouped by profile, remembers the last selection and keeps direct links to the selected format or study.
- Saved video formats are immediately available in New video, even before optional brand setup or example studies. Choosing a format selects its video setup automatically.
- Format cards show Ready to use and provide a New video action. Only reviewed style guides are included; later brand or guide additions leave existing videos unchanged.
- Setup offers an explicit Check my computer action, bounded Python environment discovery and recommendations based on installed packages and hardware.
- Check an existing project or environment location, verify its library imports, then explicitly select it for local Python work. Python presence and missing libraries are reported separately.
- No automatic package installation, model download, provider change or creator-folder relocation.

See [computer checks](onboarding-scan.md) and [formats and storage](learning-and-storage.md). Verified with 205 tests, disposable API/fake-agent runs and browser creation. Native Windows environment execution and real-provider output remain unverified for these changes. This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.7

- Scoped SQLite memories, review inbox, source quotes, revisions, explicit replacement, expiry and forgetting.
- Remember this and Review lessons in chats; local correction checkpoints before compaction and after export.
- Bounded shared agent context and generated MEMORY.md, plus scoped FTS history search and a read-only recall command.
- Explicit previewed app-history import, migration backups and restore exclusions that preserve forgotten sources.
- Memory failures leave ordinary chat and compaction usable. No background model jobs or automatic skill changes.

See [workflow and limits](memories.md). This is a source update on main; the downloadable tagged prerelease remains separate.

# v0.1.0-beta.6

- Video formats separates Research a format, Study examples and viewing an
  approved guide. Start a conversation without adding references first.
- Review the assistant's suggested example links before adding them to a study.
  Existing evidence review and guide approval remain required.
- Rejected chat messages return to the composer with a persistent error, so
  text is available to retry. New studies retain a reloadable URL.
- Usage meters now show timestamped, provider-specific agent reports, support
  current Claude rate-limit events, hide unknown/stale percentages and discard
  old readings on server restart. They are explicitly marked as not live.

See [research, conversations and usage](format-research.md). No studio folders,
media paths, schema identifiers or existing guides are moved by this update.
Verification uses synthetic references and fake agents; actual provider search,
website access and live account usage are not established by these checks.

---

# v0.1.0-beta.5

- Video formats replaces the Learning label. Study examples opens a study;
  its reviewed result is an Approved guide. Existing URLs and database IDs stay valid.
- Library sounds now use a SQLite catalog for descriptions, source/licence notes,
  tags, revisions and approval history. Edit details and search tags in Library.
- Migration backs up the database and legacy metadata before import. Audio paths
  and existing project cues stay intact. Approval keeps candidate files in place;
  discarded candidates remain recoverable on disk and in catalog history.
- Agents receive exact audio paths through the catalog API/CLI and generated
  snapshot. Legacy styles remain usable by old projects; new studies go to Video
  formats, with an option to reuse old style notes as examples.

See [storage and update rules](storage-updates.md) for backup scope and recovery.
Verification: 180 isolated tests, 19 disposable runtime groups and browser checks
for format studies, metadata editing/search, audio serving and legacy note reuse.
Synthetic media/fake agents only; real provider search and listening quality are
not proven by these checks. Audio needs its own backup alongside SQLite.

---

# v0.1.0-beta.4

- Learn this format now opens an examples-first workspace immediately. Drop
  videos/images or other supported files, add several URLs, or add written examples.
- New sessions discover relevant patterns automatically. Guidance is optional;
  study name and inspection depth are tucked into Study settings. Existing
  sessions retain their selected focus.
- Show the channel/brand/series and format together, so two channels can each
  have a Shorts format with different learning histories and styles.
- Preserve guidance and successful uploads when another file in a batch fails.
  Study settings are stored in SQLite with revision and running-state checks.

Verified on macOS: 172 isolated tests, 16 fake-agent runtime groups, and browser
checks covering file drops, bulk links, partial failures and Learn → review →
approve. Real provider access and the quality of learned conclusions still need
creator testing. This discovers patterns in supplied examples; it does not
search the web automatically for reference videos.

---

# v0.1.0-beta.3

- Clear the Updates “New” badge when no app update is available. Skill review
  notices remain inside Updates and no longer count as new app versions.
- Explain profiles and formats with channel examples and useful placeholders.
  “Video setup” selects the starting workflow; the format name is your own label.
- Copy an approved format into another profile after reviewing its guide. The
  copy gets independent learning history, retains source provenance and uses
  the destination profile's brand. Personal skill selections can be shared.

Verified on macOS: 170 isolated tests, 16 fake-agent runtime groups, and browser
checks of profile creation, setup presets, reviewed copy and badge clearing.
No packages/models are installed; Python/SAM discovery remains a follow-up.

---

# v0.1.0-beta.2

Adds Learning, profile-specific brands and SQLite-backed skills/instructions.
Choose a profile and approved learned format in New video to include their brand,
instructions, core workflows and selected personal skills. Existing videos retain
their saved versions when a brand or learned format changes.

## Included

- Reference studies with optional local frame extraction, evidence review,
  approved format versions and reusable workflow skills/assets.
- Profile brand onboarding from a website, using the selected agent, with review
  before approval. Multiple learned formats can belong to one profile.
- Editable skill explanations, Core/Customized core/Personal ownership, retained
  versions, shared instructions and database backup/recovery.
- New studio storage in OS application data. Existing studio paths, recordings
  and editor files stay in place; accepted skill data migrates to SQLite.

## Updating

Requires Node 22.13+ on 22.x or 23.4+ (Node 24 recommended). No npm install or
separate database service is required. Back up your studio before updating.
Settings → Updates → Check for updates offers the update for Git installations.
If your installed updater reports changed runtime requirements, stop the app,
run `git pull --ff-only` in its checkout, and start it again with `./start.sh`
(macOS) or `start.cmd` (Windows). Do not delete local settings or the studio.

Incomplete onboarding remains incomplete after the update. Open Setup to revisit
it, or use Settings → Brand profiles and Learning from an existing setup.
An update does not reset your database or settings.

## Verified and remaining limits

On macOS with Node 24.21.0: 167 isolated tests and 14 runtime integration groups
passed, including synthetic frame extraction, fake-agent brand/learning approval,
project context pins, backup/restore and origin rejection. This does not establish
real-provider study quality or new native Windows/Linux storage behavior.

Existing Python environments in other studios and standalone SAM checkpoint files
are not automatically discovered. This update does not fix that detection gap or
install packages/models. After Effects export and timed overlays remain deferred.
See [learning and storage](learning-and-storage.md) for migration and recovery details.

---

# v0.1.0-beta.1

Initial source prerelease of Video Octopus, a local browser video editor using a
separately installed Claude Code, Codex or Pi agent. macOS has the broadest test
coverage; Windows is experimental with startup and affected exports verified on
a native hosted runner. This release includes no AI subscription or model.

## Included

- Browser screen/camera/microphone recording, teleprompter, transcript cuts,
  ordered blocks, shots, zooms, scenes, backgrounds and media/text/layer exports.
- Six generic feature skills, managed core updates, validated creator
  preferences and preserved custom forks. New app skills arrive with app updates;
  modified personal skills remain available without automatic text merging.
- Opaque generated-visual sandboxes with scoped local assets and guarded app
  APIs; local scene kits, overrides/keyframes and exact export timing retained.
- Correct Windows software-decoding arguments for plain, shot and layer exports.
- Node 22.2+ preflight checks and explicit prerequisite messages before launch.

## Install and update

Follow the [README](../README.md). Use a current Node 22 LTS or Node 24 release,
Chrome/Edge, FFmpeg/ffprobe and your separately configured agent. No app `npm
install` is required. Python packages and model weights are separate requirements
for local transcription and object separation.

Keep the app checkout and studio separate. Existing Git users can update with
`git pull --ff-only` and restart. This release raises the declared Node minimum;
older copies may require that manual update before one-button updates resume.
Never discard a creator's studio or ignored `local/` settings/chat folder when
replacing a ZIP installation. Review migrated customized skills in Settings.

## Evidence and limits

See [verification](managed-skills-verification.md) for exact revisions, commands,
platform coverage and test receipts. Tests use synthetic media, disposable
studios and fake agents where stated. Successful metadata/routing checks do not
prove real provider authentication, model obedience or editing quality.

Physical recording devices, all Windows/Linux workflows, SAM/MLX inference,
power-loss durability and external-editor timeline imports remain outside the
recorded coverage. Layer exports and timeline XML have documented fidelity
limits. Generated visuals require local assets; arbitrary network access and
workers are blocked.

See [asset provenance](asset-provenance.md) for appearance previews and font
notices. No top-level application licence is supplied. Optional external skill
packs have their own content and terms and are installed only when selected.
