import type { EditorComponent } from "@earendil-works/pi-tui";

/** Observe user edits, not setText calls that restore drafts during resume/reload. */
export function observeComposerActivity(editor: EditorComponent, onActivity: () => void): void {
	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		const previousText = editor.getText();
		const onSubmit = editor.onSubmit;
		let submitted = false;
		editor.onSubmit = (text) => {
			submitted = true;
			onSubmit?.(text);
		};
		try {
			handleInput(data);
			// Submission clears the editor and is handled by prompt admission instead.
			if (!submitted && editor.getText() !== previousText) onActivity();
		} finally {
			editor.onSubmit = onSubmit;
		}
	};
}
