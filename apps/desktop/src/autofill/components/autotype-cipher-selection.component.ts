import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { CommonModule } from "@angular/common";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import {
  ButtonModule,
  DIALOG_DATA,
  DialogModule,
  DialogRef,
  DialogService,
} from "@bitwarden/components";
import { I18nPipe } from "@bitwarden/ui-common";

export type AutotypeCipherSelectionOption = {
  index: number;
  name: string;
  username: string;
};

type AutotypeCipherSelectionData = {
  options: AutotypeCipherSelectionOption[];
};

@Component({
  selector: "desktop-autotype-cipher-selection",
  templateUrl: "./autotype-cipher-selection.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogModule, CommonModule, ButtonModule, I18nPipe],
})
export class AutotypeCipherSelectionComponent {
  protected readonly dialogRef = inject<DialogRef<number | null>>(DialogRef);
  protected readonly data = inject<AutotypeCipherSelectionData>(DIALOG_DATA);
  private readonly i18nService = inject(I18nService);

  protected getOptionLabel(option: AutotypeCipherSelectionOption): string {
    const name = option.name?.trim() || this.i18nService.t("autotypeCipherUnnamed");
    const username = option.username?.trim();

    return username ? `${name} (${username})` : name;
  }

  protected select(optionIndex: number): void {
    void this.dialogRef.close(optionIndex);
  }

  protected cancel(): void {
    void this.dialogRef.close(null);
  }

  static open(
    dialogService: DialogService,
    data: AutotypeCipherSelectionData,
  ): DialogRef<number | null> {
    return dialogService.open<number | null, AutotypeCipherSelectionData>(
      AutotypeCipherSelectionComponent,
      { data },
    );
  }
}
