import { firstValueFrom } from "rxjs";

import { ApiService } from "../../abstractions/api.service";
import { HttpStatusCode } from "../../enums";
import { ErrorResponse } from "../../models/response/error.response";
import { EnvironmentService } from "../../platform/abstractions/environment.service";

import { PasswordPreloginRequest } from "./password-prelogin.request";
import { PasswordPreloginResponse } from "./password-prelogin.response";

export class PasswordPreloginApiService {
  constructor(
    private apiService: ApiService,
    private environmentService: EnvironmentService,
  ) {}

  async getPreloginData(request: PasswordPreloginRequest): Promise<PasswordPreloginResponse> {
    const env = await firstValueFrom(this.environmentService.environment$);
    try {
      const r = await this.apiService.send(
        "POST",
        "/accounts/prelogin/password",
        request,
        false,
        true,
        env.getIdentityUrl(),
      );
      return new PasswordPreloginResponse(r);
    } catch (error) {
      const statusCode =
        error instanceof ErrorResponse
          ? error.statusCode
          : (error as { statusCode?: number } | null)?.statusCode;

      // Fallback for older Vaultwarden/Bitwarden servers that still expose only /accounts/prelogin.
      if (statusCode === HttpStatusCode.NotFound) {
        const fallbackResponse = await this.apiService.send(
          "POST",
          "/accounts/prelogin",
          request,
          false,
          true,
          env.getIdentityUrl(),
        );
        return new PasswordPreloginResponse(fallbackResponse);
      }

      throw error;
    }
  }
}
