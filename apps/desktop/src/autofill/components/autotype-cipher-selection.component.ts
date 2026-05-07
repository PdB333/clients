import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import {
  ButtonModule,
  DIALOG_DATA,
  DialogModule,
  DialogRef,
  DialogService,
  FormFieldModule,
} from "@bitwarden/components";
import { I18nPipe } from "@bitwarden/ui-common";

export type AutotypeCipherSelectionOption = {
  index: number;
  cipherIndex: number;
  name: string;
  username: string;
  sequenceTemplate: string;
  sequenceSource: string;
};

type AutotypeCipherSelectionData = {
  options: AutotypeCipherSelectionOption[];
  windowTitle: string;
  windowTitleHistory?: string[];
};

@Component({
  selector: "desktop-autotype-cipher-selection",
  templateUrl: "./autotype-cipher-selection.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogModule, CommonModule, FormsModule, ButtonModule, FormFieldModule, I18nPipe],
})
export class AutotypeCipherSelectionComponent {
  protected readonly dialogRef = inject<DialogRef<number | null>>(DialogRef);
  protected readonly data = inject<AutotypeCipherSelectionData>(DIALOG_DATA);
  private readonly i18nService = inject(I18nService);
  protected query = "";
  protected selectedIndex = 0;

  protected getOptionLabel(option: AutotypeCipherSelectionOption): string {
    const name = option.name?.trim() || this.i18nService.t("autotypeCipherUnnamed");
    const username = option.username?.trim();

    return username ? `${name} (${username})` : name;
  }

  protected get filteredOptions(): AutotypeCipherSelectionOption[] {
    const q = this.query.trim().toLowerCase();
    const options = this.data.options;

    if (!q) {
      return options;
    }

    return options.filter((o) => {
      const label = this.getOptionLabel(o).toLowerCase();
      return (
        label.includes(q) ||
        o.sequenceTemplate.toLowerCase().includes(q) ||
        o.sequenceSource.toLowerCase().includes(q)
      );
    });
  }

  protected select(optionIndex: number): void {
    void this.dialogRef.close(optionIndex);
  }

  protected submitSelected(): void {
    const selected = this.filteredOptions[this.selectedIndex];
    if (selected != null) {
      this.select(selected.index);
    }
  }

  protected handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      this.submitSelected();
      return;
    }

    const options = this.filteredOptions;
    if (options.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % options.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + options.length) % options.length;
    }
  }

  protected onQueryChanged(): void {
    this.selectedIndex = 0;
  }

  protected isSelected(option: AutotypeCipherSelectionOption): boolean {
    return this.filteredOptions[this.selectedIndex]?.index === option.index;
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
