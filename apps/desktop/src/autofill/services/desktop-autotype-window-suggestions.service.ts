import { Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { AutotypeWindowSuggestionsService } from "@bitwarden/vault";

import { DesktopAutotypeService } from "./desktop-autotype.service";

@Injectable()
export class DesktopAutotypeWindowSuggestionsService implements AutotypeWindowSuggestionsService {
  constructor(private desktopAutotypeService: DesktopAutotypeService) {}

  async getWindowTitleSuggestions(): Promise<string[]> {
    return (await firstValueFrom(this.desktopAutotypeService.autotypeWindowTitleHistory$)).slice(
      0,
      50,
    );
  }
}

