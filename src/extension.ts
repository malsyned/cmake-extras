import * as vscode from 'vscode';
import * as cmake from 'vscode-cmake-tools';

let api: cmake.CMakeToolsApi;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const cmakeToolsExtension: cmake.CMakeToolsExtensionExports = await vscode.extensions.getExtension('ms-vscode.cmake-tools')?.activate();
	api = cmakeToolsExtension.getApi(cmake.Version.v3);

	context.subscriptions.push(
		vscode.tasks.registerTaskProvider('cmake-ensure-toolchain-target', new CMakeEnsureToolchainTaskProvider())
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("cmake-extras.ensure-toolchain-target", ensureToolchainMatchesTargetCommand)
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}

class CMakeEnsureToolchainTaskProvider implements vscode.TaskProvider {
	resolveTask(task: vscode.Task): vscode.ProviderResult<vscode.Task> {
		const execution = new vscode.CustomExecution(
			async (resolvedDefinition: vscode.TaskDefinition): Promise<vscode.Pseudoterminal> => {
			return new CMakeEnsureToolchainPty(
				resolvedDefinition.target || '',
				resolvedDefinition.postChangeSteps || []
			);
		});
		const newTask = new vscode.Task(
			task.definition,
			task.scope ?? vscode.TaskScope.Workspace,
			`${task.definition.label}`,
			'CMake Extras',
			execution,
			[]
		);
		return newTask;
	}
	provideTasks(): vscode.ProviderResult<vscode.Task[]> {
		return [];
	}
}

async function toolchainMatchesTarget(target: string): Promise<boolean>
{
	const proj = await api.getProject(vscode.Uri.file(api.getActiveFolderPath()));
	const toolchains = proj?.codeModel?.toolchains;
	if (!toolchains) {
		// Print some message about being unable to look up toolchains, then
		// punt
		return true;
	}

	for (const [_name, toolchain] of toolchains)
	{
		if (toolchain.target) {
			return (target === toolchain.target);
		}
	}
	const result = !target;
	return result;
}

async function ensureToolchainMatchesTargetCommand(args: string | string[]): Promise<string> {
	let target: string;
	let post_change_steps: string[] = [];
	if (typeof(args) === 'string') {
		target = args;
	} else {
		target = args[0];
		post_change_steps = args.slice(1);
	}

	await ensureToolchainMatchesTarget(target, post_change_steps);

	// Return a string so that this command can be used as an input in
	// launch.json or task.json.
	return '';
}

async function ensureToolchainMatchesTarget(target: string, post_change_steps: string[]): Promise<void> {
	let message: string;
	if (target) {
		message = `CMake Toolchain's target doesn't match required target ${target}.`;
	} else {
		message = 'CMake Toolchain has a cross-compilation target. Native toolchain required.';
	}
	const SELECT_PRESET: vscode.MessageItem = { title: 'Change Configure Preset' };
	const ABORT: vscode.MessageItem = { title: 'Abort',
										isCloseAffordance: true };
	const CONTINUE_ANYWAY: vscode.MessageItem = { title: 'Continue anyway' };

	let toolchain_changed = false;
	while (!await toolchainMatchesTarget(target)) {
		let response = await vscode.window.showErrorMessage(
			message, { modal: true }, SELECT_PRESET, ABORT, CONTINUE_ANYWAY
		);

		if (response === SELECT_PRESET) {
			const result: Boolean = await vscode.commands.executeCommand('cmake.selectConfigurePreset');
			if (result) {
				toolchain_changed = true;
			} else {
				response = ABORT;
			}
		}
		if (response === ABORT) {
			throw new AbortError(`Aborted. No CMake Toolchain matching the target ${target} was selected.`);
		} else if (response === CONTINUE_ANYWAY) {
			break;
		}
	}

	if (toolchain_changed) {
		for (const step of post_change_steps) {
			await vscode.commands.executeCommand(`cmake.${step}`);
		}
	}
}

class CMakeEnsureToolchainPty implements vscode.Pseudoterminal {
	constructor(private target: string, private post_change_steps: string[]) { }
	private writeEmitter = new vscode.EventEmitter<string>();
	private closeEmitter = new vscode.EventEmitter<number>();
	onDidWrite = this.writeEmitter.event;
	onDidClose = this.closeEmitter.event;

	async open(_initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
		try {
			await ensureToolchainMatchesTarget(this.target, this.post_change_steps);
			this.closeEmitter.fire(0);
		} catch (e) {
			if (e instanceof AbortError) {
				this.closeEmitter.fire(1);
			} else {
				throw e;
			}
		}
	}

	close(): void { }
}

// Format a string for terminal output
function t(s: string): string {
	return s.replaceAll('\n', '\r\n');
}

class AbortError extends Error { }
