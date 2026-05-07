// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { DatePipe, NgIf } from "@angular/common";
import { Component, DestroyRef, inject, OnInit, Optional } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormArray, FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { map } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { AuditService } from "@bitwarden/common/abstractions/audit.service";
import { EventCollectionService, EventType } from "@bitwarden/common/dirt/event-logs";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { FieldType } from "@bitwarden/common/vault/enums";
import { FieldView } from "@bitwarden/common/vault/models/view/field.view";
import { Fido2CredentialView } from "@bitwarden/common/vault/models/view/fido2-credential.view";
import { LoginView } from "@bitwarden/common/vault/models/view/login.view";
import {
  AsyncActionsModule,
  CardComponent,
  FormFieldModule,
  IconButtonModule,
  LinkModule,
  PopoverModule,
  SectionHeaderComponent,
  ToastService,
  TypographyModule,
} from "@bitwarden/components";

import { CipherFormGenerationService } from "../../abstractions/cipher-form-generation.service";
import { AutotypeWindowSuggestionsService } from "../../abstractions/autotype-window-suggestions.service";
import { TotpCaptureService } from "../../abstractions/totp-capture.service";
import { CipherFormContainer } from "../../cipher-form-container";
import { AutofillOptionsComponent } from "../autofill-options/autofill-options.component";

const AUTOTYPE_ENABLED_FIELD = "autotype:enabled";
const AUTOTYPE_SEQUENCE_FIELD = "autotype:sequence";
const AUTOTYPE_SEQUENCE_WINDOW_PREFIX = "autotype:sequence:window:";
const DEFAULT_AUTOTYPE_SEQUENCE = "{USERNAME}{TAB}{PASSWORD}{ENTER}";

type AutotypeAssociation = {
  windowMatcher: string;
  sequenceTemplate: string;
};

type ParsedAutotypeConfig = {
  enabled: boolean;
  useCustomDefaultSequence: boolean;
  defaultSequence: string;
  associations: AutotypeAssociation[];
};

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "vault-login-details-section",
  templateUrl: "./login-details-section.component.html",
  imports: [
    ReactiveFormsModule,
    SectionHeaderComponent,
    TypographyModule,
    JslibModule,
    CardComponent,
    FormFieldModule,
    IconButtonModule,
    AsyncActionsModule,
    NgIf,
    PopoverModule,
    AutofillOptionsComponent,
    LinkModule,
  ],
})
export class LoginDetailsSectionComponent implements OnInit {
  EventType = EventType;
  loginDetailsForm = this.formBuilder.group({
    username: [""],
    password: [""],
    totp: [""],
    autotypeEnabled: [true],
    autotypeUseCustomDefaultSequence: [false],
    autotypeDefaultSequence: [DEFAULT_AUTOTYPE_SEQUENCE],
    autotypeAssociations: this.formBuilder.array([]),
  });

  windowTitleSuggestions: string[] = [];

  get autotypeAssociations(): FormArray {
    return this.loginDetailsForm.controls.autotypeAssociations as FormArray;
  }

  /**
   * Flag indicating whether a new password has been generated for the current form.
   */
  newPasswordGenerated: boolean;

  /**
   * Whether the TOTP field can be captured from the current tab. Only available in the browser extension and
   * when not in a popout window.
   */
  get canCaptureTotp() {
    return (
      !!this.totpCaptureService?.canCaptureTotp(window) &&
      this.loginDetailsForm.controls.totp.enabled
    );
  }

  private datePipe = inject(DatePipe);

  /**
   * A local reference to the Fido2 credentials for an existing login being edited.
   * These cannot be created in the form and thus have no form control.
   * @private
   */
  private existingFido2Credentials?: Fido2CredentialView[];

  private destroyRef = inject(DestroyRef);

  get hasPasskey(): boolean {
    return this.existingFido2Credentials != null && this.existingFido2Credentials.length > 0;
  }

  get fido2CredentialCreationDateValue(): string {
    const dateCreated = this.i18nService.t("dateCreated");
    const creationDate = this.datePipe.transform(
      this.existingFido2Credentials?.[0]?.creationDate,
      "short",
    );
    return `${dateCreated} ${creationDate}`;
  }

  get viewHiddenFields() {
    if (this.cipherFormContainer.originalCipherView) {
      return this.cipherFormContainer.originalCipherView.viewPassword;
    }
    return true;
  }

  get initialValues() {
    return this.cipherFormContainer.config.initialValues;
  }

  constructor(
    private cipherFormContainer: CipherFormContainer,
    private formBuilder: FormBuilder,
    private i18nService: I18nService,
    private generationService: CipherFormGenerationService,
    private auditService: AuditService,
    private toastService: ToastService,
    private eventCollectionService: EventCollectionService,
    @Optional() private autotypeWindowSuggestionsService?: AutotypeWindowSuggestionsService,
    @Optional() private totpCaptureService?: TotpCaptureService,
  ) {
    this.cipherFormContainer.registerChildForm("loginDetails", this.loginDetailsForm);

    this.loginDetailsForm.valueChanges
      .pipe(
        takeUntilDestroyed(),
        // getRawValue() is used as fields can be disabled when passwords are hidden
        map(() => this.loginDetailsForm.getRawValue()),
      )
      .subscribe((value) => {
        this.cipherFormContainer.patchCipher((cipher) => {
          Object.assign(cipher.login, {
            username: value.username,
            password: value.password,
            totp: value.totp?.trim(),
          } as LoginView);

          cipher.fields = this.applyAutotypeConfigToFields(
            cipher.fields,
            value.autotypeEnabled ?? true,
            value.autotypeUseCustomDefaultSequence ?? false,
            value.autotypeDefaultSequence ?? DEFAULT_AUTOTYPE_SEQUENCE,
            value.autotypeAssociations ?? [],
          );

          return cipher;
        });
      });
  }

  ngOnInit() {
    const prefillCipher = this.cipherFormContainer.getInitialCipherView();

    if (prefillCipher) {
      this.initFromExistingCipher(prefillCipher.login);
      this.initAutotypeConfigFromFields(prefillCipher.fields);
    } else {
      this.initNewCipher();
    }

    void this.loadWindowTitleSuggestions();

    if (this.cipherFormContainer.config.mode === "partial-edit") {
      this.loginDetailsForm.disable();
    }

    // If the form is enabled, ensure to disable password or TOTP
    // for hidden password users
    this.cipherFormContainer.formStatusChange$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((status) => {
        if (status === "enabled") {
          if (!this.viewHiddenFields) {
            this.loginDetailsForm.controls.password.disable();
            this.loginDetailsForm.controls.totp.disable();
          }
        }
      });
  }

  private initFromExistingCipher(existingLogin: LoginView) {
    this.loginDetailsForm.patchValue(
      {
        username: this.initialValues?.username ?? existingLogin.username,
        password: this.initialValues?.password ?? existingLogin.password,
        totp: existingLogin.totp,
      },
      { emitEvent: false },
    );

    if (this.cipherFormContainer.config.mode != "clone") {
      this.existingFido2Credentials = existingLogin.fido2Credentials;
    }

    if (!this.viewHiddenFields) {
      this.loginDetailsForm.controls.password.disable();
      this.loginDetailsForm.controls.totp.disable();
    }
  }

  private initNewCipher() {
    this.loginDetailsForm.patchValue(
      {
        username: this.initialValues?.username || "",
        password: this.initialValues?.password || "",
      },
      { emitEvent: false },
    );
    this.loginDetailsForm.patchValue(
      {
        autotypeEnabled: true,
        autotypeUseCustomDefaultSequence: false,
        autotypeDefaultSequence: DEFAULT_AUTOTYPE_SEQUENCE,
      },
      { emitEvent: false },
    );
  }

  addAutotypeAssociation = () => {
    this.autotypeAssociations.push(this.createAutotypeAssociationGroup());
  };

  removeAutotypeAssociation = (index: number) => {
    this.autotypeAssociations.removeAt(index);
  };

  private createAutotypeAssociationGroup(
    association: AutotypeAssociation = { windowMatcher: "", sequenceTemplate: "" },
  ) {
    return this.formBuilder.group({
      windowMatcher: [association.windowMatcher ?? ""],
      sequenceTemplate: [association.sequenceTemplate ?? ""],
    });
  }

  private initAutotypeConfigFromFields(fields?: FieldView[] | null) {
    const parsed = this.parseAutotypeConfig(fields);

    this.autotypeAssociations.clear();
    for (const association of parsed.associations) {
      this.autotypeAssociations.push(this.createAutotypeAssociationGroup(association));
    }

    this.loginDetailsForm.patchValue(
      {
        autotypeEnabled: parsed.enabled,
        autotypeUseCustomDefaultSequence: parsed.useCustomDefaultSequence,
        autotypeDefaultSequence: parsed.defaultSequence,
      },
      { emitEvent: false },
    );
  }

  private parseAutotypeConfig(fields?: FieldView[] | null): ParsedAutotypeConfig {
    const parsed: ParsedAutotypeConfig = {
      enabled: true,
      useCustomDefaultSequence: false,
      defaultSequence: DEFAULT_AUTOTYPE_SEQUENCE,
      associations: [],
    };

    for (const field of fields ?? []) {
      const name = field.name?.trim();
      const value = field.value?.trim();
      if (!name || !value) {
        continue;
      }

      const lowerName = name.toLowerCase();
      if (lowerName === AUTOTYPE_ENABLED_FIELD) {
        parsed.enabled = value.toLowerCase() !== "false";
        continue;
      }

      if (lowerName === AUTOTYPE_SEQUENCE_FIELD) {
        parsed.useCustomDefaultSequence = true;
        parsed.defaultSequence = value;
        continue;
      }

      if (lowerName.startsWith(AUTOTYPE_SEQUENCE_WINDOW_PREFIX)) {
        const matcher = name.substring(AUTOTYPE_SEQUENCE_WINDOW_PREFIX.length).trim();
        if (matcher) {
          parsed.associations.push({
            windowMatcher: matcher,
            sequenceTemplate: value,
          });
        }
      }
    }

    return parsed;
  }

  private applyAutotypeConfigToFields(
    existingFields: FieldView[] | null | undefined,
    enabled: boolean,
    useCustomDefaultSequence: boolean,
    defaultSequence: string,
    associations: AutotypeAssociation[],
  ): FieldView[] {
    const preservedFields = (existingFields ?? []).filter((field) => {
      const name = field.name?.trim().toLowerCase();
      if (!name) {
        return true;
      }
      return !this.isAutotypeManagedField(name);
    });

    const managedFields: FieldView[] = [];
    if (!enabled) {
      managedFields.push(this.makeField(AUTOTYPE_ENABLED_FIELD, "false"));
      return [...preservedFields, ...managedFields];
    }

    if (useCustomDefaultSequence && defaultSequence?.trim()) {
      managedFields.push(this.makeField(AUTOTYPE_SEQUENCE_FIELD, defaultSequence.trim()));
    }

    for (const association of associations ?? []) {
      const matcher = association?.windowMatcher?.trim();
      const sequenceTemplate = association?.sequenceTemplate?.trim();
      if (!matcher || !sequenceTemplate) {
        continue;
      }

      managedFields.push(
        this.makeField(`${AUTOTYPE_SEQUENCE_WINDOW_PREFIX}${matcher}`, sequenceTemplate),
      );
    }

    return [...preservedFields, ...managedFields];
  }

  private isAutotypeManagedField(fieldNameLowercase: string): boolean {
    return (
      fieldNameLowercase === AUTOTYPE_ENABLED_FIELD ||
      fieldNameLowercase === AUTOTYPE_SEQUENCE_FIELD ||
      fieldNameLowercase.startsWith(AUTOTYPE_SEQUENCE_WINDOW_PREFIX)
    );
  }

  private makeField(name: string, value: string): FieldView {
    const field = new FieldView();
    field.type = FieldType.Text;
    field.name = name;
    field.value = value;
    return field;
  }

  private async loadWindowTitleSuggestions() {
    if (!this.autotypeWindowSuggestionsService) {
      return;
    }

    try {
      this.windowTitleSuggestions = await this.autotypeWindowSuggestionsService.getWindowTitleSuggestions();
    } catch {
      this.windowTitleSuggestions = [];
    }
  }

  /** Logs the givin event when in edit mode */
  logVisibleEvent = async (passwordVisible: boolean, event: EventType) => {
    const { mode, originalCipher } = this.cipherFormContainer.config;

    const isEdit = ["edit", "partial-edit"].includes(mode);

    if (!passwordVisible || !isEdit || !originalCipher) {
      return;
    }

    await this.eventCollectionService.collect(
      event,
      originalCipher.id,
      false,
      originalCipher.organizationId,
    );
  };

  captureTotp = async () => {
    if (!this.canCaptureTotp) {
      return;
    }
    try {
      const totp = await this.totpCaptureService.captureTotpSecret();
      if (totp) {
        this.loginDetailsForm.controls.totp.patchValue(totp);
        this.toastService.showToast({
          variant: "success",
          title: null,
          message: this.i18nService.t("totpCaptureSuccess"),
        });
      }
    } catch {
      this.toastService.showToast({
        variant: "error",
        title: this.i18nService.t("errorOccurred"),
        message: this.i18nService.t("totpCaptureError"),
      });
    }
  };

  removePasskey = async () => {
    // Fido2Credentials do not have a form control, so update directly
    this.existingFido2Credentials = null;
    this.cipherFormContainer.patchCipher((cipher) => {
      cipher.login.fido2Credentials = null;
      return cipher;
    });
  };

  /**
   * Generate a new password and update the form.
   * TODO: Browser extension needs a means to cache the current form so values are not lost upon navigating to the generator.
   */
  generatePassword = async () => {
    const newPassword = await this.generationService.generatePassword();

    if (newPassword) {
      this.loginDetailsForm.controls.password.patchValue(newPassword);
      this.newPasswordGenerated = true;
    }
  };

  /**
   * Generate a new username and update the form.
   * TODO: Browser extension needs a means to cache the current form so values are not lost upon navigating to the generator.
   */
  generateUsername = async () => {
    const newUsername = await this.generationService.generateUsername(
      this.cipherFormContainer.website,
    );
    if (newUsername) {
      this.loginDetailsForm.controls.username.patchValue(newUsername);
    }
  };

  /**
   * Checks if the password has been exposed in a data breach using the AuditService.
   */
  checkPassword = async () => {
    const password = this.loginDetailsForm.controls.password.value;

    if (password == null || password === "") {
      return;
    }

    const matches = await this.auditService.passwordLeaked(password);

    if (matches > 0) {
      this.toastService.showToast({
        variant: "warning",
        title: null,
        message: this.i18nService.t("passwordExposed", matches.toString()),
      });
    } else {
      this.toastService.showToast({
        variant: "success",
        title: null,
        message: this.i18nService.t("passwordSafe"),
      });
    }
  };
}
