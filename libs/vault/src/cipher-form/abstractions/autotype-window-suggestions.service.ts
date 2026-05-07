export abstract class AutotypeWindowSuggestionsService {
  abstract getWindowTitleSuggestions(): Promise<string[]>;
}

