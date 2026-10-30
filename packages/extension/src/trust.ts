// Whether this workspace is trusted. VS Code always reports "trusted" during test
// runs, so the in-editor tests simulate Restricted Mode with an environment variable.
// It can only take trust away until grant() is called, never add it.
import * as vscode from 'vscode';

export class WorkspaceTrust implements vscode.Disposable {
  private simulatedRestricted = process.env.IDEA_TO_CODE_TEST_RESTRICTED === '1';
  private readonly granted = new vscode.EventEmitter<void>();
  private readonly subscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    this.granted.fire();
  });

  readonly onDidGrant = this.granted.event;

  get isTrusted(): boolean {
    return vscode.workspace.isTrusted && !this.simulatedRestricted;
  }

  /** For the tests: what trusting the folder does. */
  simulateGrant(): void {
    this.simulatedRestricted = false;
    this.granted.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.granted.dispose();
  }
}
