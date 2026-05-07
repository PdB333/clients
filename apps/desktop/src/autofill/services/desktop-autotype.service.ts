import { Injectable, OnDestroy } from "@angular/core";
import {
  concatMap,
  distinctUntilChanged,
  filter,
  firstValueFrom,
  map,
  Observable,
  of,
  Subject,
  switchMap,
  takeUntil,
} from "rxjs";
import { DialogService } from "@bitwarden/components";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { DeviceType } from "@bitwarden/common/enums";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import {
  GlobalStateProvider,
  AUTOTYPE_SETTINGS_DISK,
  KeyDefinition,
} from "@bitwarden/common/platform/state";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { LogService } from "@bitwarden/logging";
import { UserId } from "@bitwarden/user-core";

import { AutotypeCipherSelectionComponent } from "../components/autotype-cipher-selection.component";
import { AutotypeConfig } from "../models/autotype-config";
import {
  AutotypeSequenceMode,
  DEFAULT_AUTOTYPE_SEQUENCE_MODE,
  isAutotypeSequenceMode,
} from "../models/autotype-sequence-mode";
import { AutotypeVaultData } from "../models/autotype-vault-data";
import { DEFAULT_KEYBOARD_SHORTCUT } from "../models/main-autotype-keyboard-shortcut";

export const AUTOTYPE_ENABLED = new KeyDefinition<boolean | null>(
  AUTOTYPE_SETTINGS_DISK,
  "autotypeEnabled",
  { deserializer: (b) => b },
);

export type Result<T, E = Error> = [E, null] | [null, T];

/*
  Valid windows shortcut keys: Control, Alt, Super, Shift, letters A - Z
  Valid macOS shortcut keys: Control, Alt, Command, Shift, letters A - Z

  See Electron keyboard shorcut docs for more info:
  https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts
*/
export const AUTOTYPE_KEYBOARD_SHORTCUT = new KeyDefinition<string[]>(
  AUTOTYPE_SETTINGS_DISK,
  "autotypeKeyboardShortcut",
  { deserializer: (b) => b },
);

export const AUTOTYPE_SEQUENCE_MODE = new KeyDefinition<AutotypeSequenceMode>(
  AUTOTYPE_SETTINGS_DISK,
  "autotypeSequenceMode",
  { deserializer: (b) => b },
);

@Injectable({
  providedIn: "root",
})
export class DesktopAutotypeService implements OnDestroy {
  private readonly autotypeEnabledState = this.globalStateProvider.get(AUTOTYPE_ENABLED);
  private readonly autotypeKeyboardShortcut = this.globalStateProvider.get(
    AUTOTYPE_KEYBOARD_SHORTCUT,
  );
  private readonly autotypeSequenceMode = this.globalStateProvider.get(AUTOTYPE_SEQUENCE_MODE);

  // The enabled/disabled state from the user settings menu
  autotypeEnabledUserSetting$: Observable<boolean> = of(false);

  autotypeKeyboardShortcut$: Observable<string[]> = of(DEFAULT_KEYBOARD_SHORTCUT);
  autotypeSequenceMode$: Observable<AutotypeSequenceMode> = of(DEFAULT_AUTOTYPE_SEQUENCE_MODE);

  private destroy$ = new Subject<void>();

  constructor(
    private accountService: AccountService,
    private authService: AuthService,
    private cipherService: CipherService,
    private globalStateProvider: GlobalStateProvider,
    private platformUtilsService: PlatformUtilsService,
    private dialogService: DialogService,
    private logService: LogService,
  ) {
    this.autotypeEnabledUserSetting$ = this.autotypeEnabledState.state$.pipe(
      map((enabled) => enabled ?? false),
      distinctUntilChanged(), // Only emit when the boolean result changes
      takeUntil(this.destroy$),
    );

    this.autotypeKeyboardShortcut$ = this.autotypeKeyboardShortcut.state$.pipe(
      map((shortcut) => shortcut ?? DEFAULT_KEYBOARD_SHORTCUT),
      takeUntil(this.destroy$),
    );

    this.autotypeSequenceMode$ = this.autotypeSequenceMode.state$.pipe(
      map((sequenceMode) =>
        isAutotypeSequenceMode(sequenceMode) ? sequenceMode : DEFAULT_AUTOTYPE_SEQUENCE_MODE,
      ),
      takeUntil(this.destroy$),
    );
  }

  async init() {
    // Currently Autotype is only supported for Windows
    if (this.platformUtilsService.getDevice() !== DeviceType.WindowsDesktop) {
      return;
    }

    ipc.autofill.listenAutotypeRequest(async (windowTitle, callback) => {
      const possibleCiphers = await this.matchCiphersToWindowTitle(windowTitle);
      const selectedCipher = await this.getSelectedCipher(possibleCiphers);
      const [error, vaultData] = getAutotypeVaultData(selectedCipher);
      callback(error, vaultData);
    });

    // listen for changes in keyboard shortcut settings
    this.autotypeKeyboardShortcut$
      .pipe(
        switchMap((keyboardShortcut) =>
          this.autotypeSequenceMode$.pipe(map((sequenceMode) => ({ keyboardShortcut, sequenceMode }))),
        ),
        concatMap(async ({ keyboardShortcut, sequenceMode }) => {
          const config: AutotypeConfig = {
            keyboardShortcut,
            sequenceMode,
          };
          ipc.autofill.configureAutotype(config);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe();

    this.autotypeFeatureEnabled$
      .pipe(
        concatMap(async (enabled) => {
          ipc.autofill.toggleAutotype(enabled);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe();
  }

  // Returns an observable that represents whether autotype is enabled for the current user.
  private get autotypeFeatureEnabled$(): Observable<boolean> {
    return this.autotypeEnabledUserSetting$.pipe(
      switchMap((settingsEnabled) =>
        this.authService.activeAccountStatus$.pipe(
          map((authStatus) => settingsEnabled && authStatus === AuthenticationStatus.Unlocked),
        ),
      ),
      distinctUntilChanged(), // Only emit when the boolean result changes
      takeUntil(this.destroy$),
    );
  }

  async setAutotypeEnabledState(enabled: boolean): Promise<void> {
    await this.autotypeEnabledState.update(() => enabled, {
      shouldUpdate: (currentlyEnabled) => currentlyEnabled !== enabled,
    });
  }

  async setAutotypeKeyboardShortcutState(keyboardShortcut: string[]): Promise<void> {
    await this.autotypeKeyboardShortcut.update(() => keyboardShortcut);
  }

  async setAutotypeSequenceModeState(sequenceMode: AutotypeSequenceMode): Promise<void> {
    if (!isAutotypeSequenceMode(sequenceMode)) {
      this.logService.error("Autotype sequence mode is invalid.");
      return;
    }

    await this.autotypeSequenceMode.update(() => sequenceMode);
  }

  async matchCiphersToWindowTitle(windowTitle: string): Promise<CipherView[]> {
    const URI_PREFIX = "apptitle://";
    windowTitle = windowTitle.toLowerCase();

    const ciphers = await firstValueFrom(
      this.accountService.activeAccount$.pipe(
        map((account) => account?.id),
        filter((userId): userId is UserId => userId != null),
        switchMap((userId) => this.cipherService.cipherViews$(userId)),
      ),
    );

    const possibleCiphers = ciphers.filter((c) => {
      return (
        c.login?.username &&
        c.login?.password &&
        c.deletedDate == null &&
        c.login?.uris.some((u) => {
          if (u.uri?.indexOf(URI_PREFIX) !== 0) {
            return false;
          }

          const uri = u.uri.substring(URI_PREFIX.length).toLowerCase();

          return windowTitle.indexOf(uri) > -1;
        })
      );
    });

    return possibleCiphers;
  }

  private async getSelectedCipher(possibleCiphers: CipherView[]): Promise<CipherView | undefined> {
    if (possibleCiphers.length === 0) {
      return undefined;
    }

    if (possibleCiphers.length === 1) {
      return possibleCiphers[0];
    }

    const options = possibleCiphers.map((cipher, index) => ({
      index,
      name: cipher.name ?? "",
      username: cipher.login?.username ?? "",
    }));

    const dialogRef = AutotypeCipherSelectionComponent.open(this.dialogService, { options });
    const selectedIndex = await firstValueFrom(dialogRef.closed);

    if (selectedIndex == null) {
      return undefined;
    }

    return possibleCiphers[selectedIndex];
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
}

/**
 * @return an `AutotypeVaultData` object or an `Error` if the
 * cipher or vault data within are undefined.
 */
export function getAutotypeVaultData(
  cipherView: CipherView | undefined,
): Result<AutotypeVaultData> {
  if (!cipherView) {
    return [Error("No matching vault item."), null];
  } else if (cipherView.login.username === undefined || cipherView.login.password === undefined) {
    return [Error("Vault item is undefined."), null];
  } else {
    const vaultData: AutotypeVaultData = {
      username: cipherView.login.username,
      password: cipherView.login.password,
    };
    return [null, vaultData];
  }
}
