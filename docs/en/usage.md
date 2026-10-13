# Usage and migration

[简体中文](../usage.md) · English

On first launch, the welcome screen invites you to build your memory universe. Choose English or Simplified Chinese, then configure your cloud model or enter the workspace. Your language preference and completed welcome state are saved in this browser.

## Start with a conversation

Tell the assistant what you learned, worked on, or want to remember in **Workspace**. Start or revisit conversations from the top of the chat panel. Stop interrupts the current reply; text already received is retained.

After each successful chat, the background organizer decides what is worth keeping. Every message need not create a note. Plans are not treated as completed experiences, and the assistant's explanation is not automatically recorded as something you have learned. Automatic organization is enabled by default and can be turned off in **Settings → Automatic organization**.

Results appear in the conversation and **Knowledge → Memory inbox**. Review completed, skipped, awaiting-confirmation, and failed jobs. Check configuration and networking before retrying a failed job; retries can make another model call.

## Documents and tags

Each note focuses on one topic. Later information on the same topic supplements the existing document. A useful smaller concept can become a separate note linked through a highlighted title.

The folder tree follows each document's archive location. Tags filter across folders, and a note can have several tags. Add, rename, or delete tags in the tag pool. Deleting a tag removes its classification links while retaining note bodies.

Find notes by title or retrieve specific sections with memory search. The assistant also uses tags, keywords, and sections and sends a bounded amount of context to the model. Coverage indicators describe the retrieved material; limited excerpts are not a complete annual record.

## Edit and confirm

Open a note and select edit to change its title, body, source, folder, or tags. When no source is provided, the date is recorded; you do not need to invent a citation.

Automatic supplements preserve your manually edited body. Explicit corrections replace the relevant text and keep version history; ambiguous corrections wait for approval. Unconfirmed proposals are not used as confirmed current facts.

In **Memory inbox**, confirm or dismiss a proposal, or supply clarification and organize it again. If versions conflict, read the latest note before saving so another change is not overwritten.

You can read historical versions or use one as an editing draft. Unsaved drafts last only in the current page session; save before refreshing or closing it.

External Markdown edits must be reviewed and imported in the document interface to update the index. Preserve internal IDs and metadata. Change archive folders in the app instead of renaming files under `notes/topics/`.

Deleting a document removes its body and version history. Conversations are stored separately and are not deleted with that note.

## Star map

Open **Knowledge → Constellation** to see documents and confirmed relationships. Select a star to view its document; select a connection to read evidence. Drag nodes or the background, zoom, or reset the view.

The force-directed map uses bright white cores, blue-white halos, and fine constellation connections. The more distinct documents a note connects to, the larger its star. Every star has a label. Hovering illuminates the star, its neighbors, and their connecting lines.

Nodes drift under link, repulsion, and collision forces. Dragging pins only the dragged star until release. Pan the background and zoom with the wheel or controls. Use **Pause motion / Resume motion** and **Reset view**. Motion pauses when the page is hidden, a dialog is open, or the graph is offscreen. Reduced-motion mode keeps a static layout with dragging and zooming available.

An empty vault shows an empty state; notes without relationships appear as individual stars. **Explore map** lets you try connections and interactions without writing to your vault or calling a model. **My knowledge** returns to your documents. Map nodes represent documents; arbitrary people or place entity graphs are not included in 1.0.

## Back up

Open **Settings → Archive and restore** and export a ZIP. It includes conversations, tags, notes, versions, relationships, and organization jobs. It excludes API Keys and model configuration.

Memory packages are not encrypted and contain your personal material. Store them somewhere you trust. Saving Markdown alone omits conversations and database records.

## Move to another computer

1. Export the ZIP on the old computer and copy it to the new one
2. Install and start MemoCosmos on the new computer
3. Select the ZIP in Settings and restore into a new vault
4. Copy the absolute vault path returned by the app
5. Stop the services and restart from the application directory with that path

```sh
uv run --project backend --no-sync python run.py --memory-dir "/absolute/path/to/restored-vault"
```

Restore creates a new persistent directory; it neither overwrites the current vault nor switches it automatically. Incomplete imported jobs do not automatically call the model; inspect them before retrying. Configure your cloud model again on the new computer. On the same computer, separate model configuration can be reused.

## Language and motion

The interface uses a dark cosmic background, continuous transitions, and subtle button feedback. Use the language menu to choose English or Simplified Chinese. Preferences are stored in this browser, and interface dates follow the selected language. Your notes, tags, evidence, and conversations keep their original language.

Enable reduced motion in **Settings → Appearance and motion**. The app also respects the system's reduced-motion preference. The manual setting lasts for the current opening of the application.
