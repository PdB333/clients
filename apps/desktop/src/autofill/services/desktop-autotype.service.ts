import { Injectable, OnDestroy } from "@angular/core";
import {
  combineLatest,
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
import { getAutotypeSequenceTemplateFromMode } from "../models/autotype-sequence-template";
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

export const AUTOTYPE_ALWAYS_SHOW_SELECTION_MENU = new KeyDefinition<boolean | null>(
  AUTOTYPE_SETTINGS_DISK,
  "autotypeAlwaysShowSelectionMenu",
  { deserializer: (b) => b },
);

export const AUTOTYPE_WINDOW_TITLE_HISTORY = new KeyDefinition<string[] | null>(
  AUTOTYPE_SETTINGS_DISK,
  "autotypeWindowTitleHistory",
  { deserializer: (b) => b },
);

export type SequenceAssociation = {
  template: string;
  source: string;
  score: number;
};

@Injectable({
  providedIn: "root",
})
export class DesktopAutotypeService implements OnDestroy {
  private static readonly AUTOTYPE_ENABLED_FIELD = "autotype:enabled";
  private static readonly AUTOTYPE_SEQUENCE_FIELD = "autotype:sequence";
  private static readonly AUTOTYPE_SEQUENCE_WINDOW_PREFIX = "autotype:sequence:window:";

  private readonly autotypeEnabledState = this.globalStateProvider.get(AUTOTYPE_ENABLED);
  private readonly autotypeKeyboardShortcut = this.globalStateProvider.get(
    AUTOTYPE_KEYBOARD_SHORTCUT,
  );
  private readonly autotypeSequenceMode = this.globalStateProvider.get(AUTOTYPE_SEQUENCE_MODE);
  private readonly autotypeAlwaysShowSelectionMenu = this.globalStateProvider.get(
    AUTOTYPE_ALWAYS_SHOW_SELECTION_MENU,
  );
  private readonly autotypeWindowTitleHistory = this.globalStateProvider.get(
    AUTOTYPE_WINDOW_TITLE_HISTORY,
  );

  // The enabled/disabled state from the user settings menu
  autotypeEnabledUserSetting$: Observable<boolean> = of(false);

  autotypeKeyboardShortcut$: Observable<string[]> = of(DEFAULT_KEYBOARD_SHORTCUT);
  autotypeSequenceMode$: Observable<AutotypeSequenceMode> = of(DEFAULT_AUTOTYPE_SEQUENCE_MODE);
  autotypeAlwaysShowSelectionMenu$: Observable<boolean> = of(false);
  autotypeWindowTitleHistory$: Observable<string[]> = of([]);

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

    this.autotypeAlwaysShowSelectionMenu$ = this.autotypeAlwaysShowSelectionMenu.state$.pipe(
      map((enabled) => enabled ?? true),
      distinctUntilChanged(),
      takeUntil(this.destroy$),
    );

    this.autotypeWindowTitleHistory$ = this.autotypeWindowTitleHistory.state$.pipe(
      map((titles) => titles ?? []),
      takeUntil(this.destroy$),
    );
  }

  async init() {
    // Currently Autotype is only supported for Windows
    if (this.platformUtilsService.getDevice() !== DeviceType.WindowsDesktop) {
      return;
    }

    ipc.autofill.listenAutotypeRequest(async (windowTitle, callback) => {
      await this.trackWindowTitle(windowTitle);
      const possibleCiphers = await this.matchCiphersToWindowTitle(windowTitle);
      const globalSequenceTemplate = getAutotypeSequenceTemplateFromMode(
        await firstValueFrom(this.autotypeSequenceMode$),
      );
      const alwaysShowSelectionMenu = await firstValueFrom(this.autotypeAlwaysShowSelectionMenu$);
      const selectedOption = await this.getSelectedAutotypeOption(
        possibleCiphers,
        windowTitle,
        globalSequenceTemplate,
        alwaysShowSelectionMenu,
      );
      const resolvedCipher = await this.getResolvedCipherForAutotype(selectedOption?.cipher);
      const [error, vaultData] = getAutotypeVaultData(
        resolvedCipher,
        windowTitle,
        globalSequenceTemplate,
        selectedOption?.sequenceTemplate,
      );
      callback(error, vaultData);
    });

    // listen for changes in keyboard shortcut settings
    combineLatest([this.autotypeKeyboardShortcut$, this.autotypeSequenceMode$])
      .pipe(
        concatMap(async ([keyboardShortcut, sequenceMode]) => {
          const config: AutotypeConfig = {
            keyboardShortcut,
            sequenceMode,
            sequenceTemplate: getAutotypeSequenceTemplateFromMode(sequenceMode),
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

  async setAutotypeAlwaysShowSelectionMenuState(alwaysShow: boolean): Promise<void> {
    await this.autotypeAlwaysShowSelectionMenu.update(() => alwaysShow);
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
        DesktopAutotypeService.isAutotypeEnabledForCipher(c) &&
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

  private async getSelectedAutotypeOption(
    possibleCiphers: CipherView[],
    windowTitle: string,
    globalSequenceTemplate: string,
    alwaysShowSelectionMenu: boolean,
  ): Promise<{ cipher: CipherView; sequenceTemplate: string } | undefined> {
    if (possibleCiphers.length === 0) {
      return undefined;
    }

    const options = this.buildSelectionOptionsForWindow(
      possibleCiphers,
      windowTitle,
      globalSequenceTemplate,
    );

    if (options.length === 0) {
      return undefined;
    }

    if (!alwaysShowSelectionMenu && options.length === 1) {
      const onlyOption = options[0];
      return {
        cipher: possibleCiphers[onlyOption.cipherIndex],
        sequenceTemplate: onlyOption.sequenceTemplate,
      };
    }

    const dialogRef = AutotypeCipherSelectionComponent.open(this.dialogService, {
      options,
      windowTitle,
      windowTitleHistory: (await firstValueFrom(this.autotypeWindowTitleHistory$)).slice(0, 25),
    });
    const selectedIndex = await firstValueFrom(dialogRef.closed);

    if (selectedIndex == null) {
      return undefined;
    }

    const selectedOption = options.find((option) => option.index === selectedIndex);
    if (selectedOption == null) {
      return undefined;
    }

    return {
      cipher: possibleCiphers[selectedOption.cipherIndex],
      sequenceTemplate: selectedOption.sequenceTemplate,
    };
  }

  private buildSelectionOptionsForWindow(
    ciphers: CipherView[],
    windowTitle: string,
    globalSequenceTemplate: string,
  ) {
    const options: {
      index: number;
      cipherIndex: number;
      name: string;
      username: string;
      sequenceTemplate: string;
      sequenceSource: string;
    }[] = [];

    let runningIndex = 0;
    for (let cipherIndex = 0; cipherIndex < ciphers.length; cipherIndex++) {
      const cipher = ciphers[cipherIndex];
      const sequences = DesktopAutotypeService.getSequenceAssociationsForWindow(
        cipher,
        windowTitle,
        globalSequenceTemplate,
      );

      for (const sequence of sequences) {
        options.push({
          index: runningIndex++,
          cipherIndex,
          name: cipher.name ?? "",
          username: cipher.login?.username ?? "",
          sequenceTemplate: sequence.template,
          sequenceSource: sequence.source,
        });
      }
    }

    return options;
  }

  private async getResolvedCipherForAutotype(
    selectedCipher: CipherView | undefined,
  ): Promise<CipherView | undefined> {
    if (selectedCipher == null || !selectedCipher.id) {
      return selectedCipher;
    }

    try {
      const userId = await firstValueFrom(
        this.accountService.activeAccount$.pipe(
          map((account) => account?.id),
          filter((id): id is UserId => id != null),
        ),
      );

      const fullCipherViews = await this.cipherService.getAllDecryptedForIds(userId, [
        selectedCipher.id,
      ]);
      return fullCipherViews[0] ?? selectedCipher;
    } catch {
      this.logService.debug("Failed to resolve full cipher view for autotype, using selected view.");
      return selectedCipher;
    }
  }

  private async trackWindowTitle(windowTitle: string): Promise<void> {
    const title = windowTitle?.trim();
    if (!title) {
      return;
    }

    await this.autotypeWindowTitleHistory.update((current) => {
      const existing = (current ?? []).filter((entry) => entry.trim().length > 0);
      const withoutDupes = existing.filter((entry) => entry.toLowerCase() !== title.toLowerCase());
      return [title, ...withoutDupes].slice(0, 50);
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  static getSequenceTemplateForWindow(
    cipherView: CipherView,
    windowTitle: string,
  ): string | undefined {
    return this.getSequenceAssociationsForWindow(cipherView, windowTitle)[0]?.template;
  }

  static getSequenceAssociationsForWindow(
    cipherView: CipherView,
    windowTitle: string,
    globalSequenceTemplate?: string,
  ): SequenceAssociation[] {
    const title = windowTitle.toLowerCase();
    let defaultTemplate: string | undefined;
    let bestMatch: { score: number; template: string; source: string } | undefined;

    const seen = new Set<string>();
    const orderedAssociations: SequenceAssociation[] = [];

    for (const field of cipherView.fields ?? []) {
      const fieldName = field.name?.trim();
      const fieldValue = field.value?.trim();
      if (!fieldName || !fieldValue) {
        continue;
      }

      const normalizedName = fieldName.toLowerCase();
      if (normalizedName === this.AUTOTYPE_SEQUENCE_FIELD) {
        defaultTemplate = fieldValue;
        continue;
      }

      if (!normalizedName.startsWith(this.AUTOTYPE_SEQUENCE_WINDOW_PREFIX)) {
        continue;
      }

      const matcher = fieldName.substring(this.AUTOTYPE_SEQUENCE_WINDOW_PREFIX.length).trim();
      if (!matcher || !windowTitleMatchesMatcher(title, matcher)) {
        continue;
      }

      const source = `Window: ${matcher}`;
      const score = matcher.length;
      if (bestMatch == null || score > bestMatch.score) {
        bestMatch = { score, template: fieldValue, source };
      }

      const dedupeKey = `${fieldValue}::${source}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        orderedAssociations.push({ template: fieldValue, source, score });
      }
    }

    if (bestMatch != null) {
      const bestDedupeKey = `${bestMatch.template}::${bestMatch.source}`;
      if (!seen.has(bestDedupeKey)) {
        orderedAssociations.unshift({
          template: bestMatch.template,
          source: bestMatch.source,
          score: bestMatch.score,
        });
      } else {
        orderedAssociations.sort((a, b) => b.score - a.score);
      }
    }

    if (defaultTemplate != null) {
      const dedupeKey = `${defaultTemplate}::Entry default`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        orderedAssociations.push({
          template: defaultTemplate,
          source: "Entry default",
          score: 0,
        });
      }
    }

    if (globalSequenceTemplate != null) {
      const dedupeKey = `${globalSequenceTemplate}::Global default`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        orderedAssociations.push({
          template: globalSequenceTemplate,
          source: "Global default",
          score: -1,
        });
      }
    }

    return orderedAssociations;
  }

  static getAutotypeCustomFieldValues(cipherView: CipherView): Record<string, string> {
    const fields = cipherView.fields ?? [];
    const customFields: Record<string, string> = {};

    for (const field of fields) {
      const fieldName = field.name?.trim();
      const fieldValue = field.value?.trim();
      if (!fieldName || !fieldValue) {
        continue;
      }

      customFields[fieldName.toLowerCase()] = fieldValue;
    }

    return customFields;
  }

  static isAutotypeEnabledForCipher(cipherView: CipherView): boolean {
    for (const field of cipherView.fields ?? []) {
      const fieldName = field.name?.trim()?.toLowerCase();
      if (fieldName !== this.AUTOTYPE_ENABLED_FIELD) {
        continue;
      }

      return field.value?.trim()?.toLowerCase() !== "false";
    }

    return true;
  }
}

/**
 * @return an `AutotypeVaultData` object or an `Error` if the
 * cipher or vault data within are undefined.
 */
export function getAutotypeVaultData(
  cipherView: CipherView | undefined,
  windowTitle: string,
  globalSequenceTemplate: string,
  selectedSequenceTemplate?: string,
): Result<AutotypeVaultData> {
  if (!cipherView) {
    return [Error("No matching vault item."), null];
  } else if (cipherView.login.username === undefined || cipherView.login.password === undefined) {
    return [Error("Vault item is undefined."), null];
  } else {
    const customFields = DesktopAutotypeService.getAutotypeCustomFieldValues(cipherView);
    const sequenceTemplate =
      selectedSequenceTemplate ??
      DesktopAutotypeService.getSequenceTemplateForWindow(cipherView, windowTitle) ??
      globalSequenceTemplate;

    const vaultData: AutotypeVaultData = {
      username: cipherView.login.username,
      password: cipherView.login.password,
      sequenceTemplate,
      title: cipherView.name,
      url: cipherView.login.uris?.[0]?.uri,
      notes: cipherView.notes,
      customFields,
    };
    return [null, vaultData];
  }
}

function windowTitleMatchesMatcher(windowTitle: string, matcher: string): boolean {
  const normalizedMatcher = matcher.toLowerCase();
  if (normalizedMatcher === "*") {
    return true;
  }

  if (matcher.startsWith("//") && matcher.endsWith("//") && matcher.length > 4) {
    const regexPattern = matcher.slice(2, -2);
    try {
      const regex = new RegExp(regexPattern, "i");
      return regex.test(windowTitle);
    } catch {
      return false;
    }
  }

  if (matcher.includes("*")) {
    const escaped = escapeRegex(matcher).replace(/\\\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(windowTitle);
  }

  return windowTitle.includes(normalizedMatcher);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
