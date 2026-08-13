// Feishu's primary single-account setup stays directly on the channel hub so
// operators can configure credentials without opening detail or wizard layers.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import type { ChannelsProps } from "./view.types.ts";

const FEISHU_CONFIG_PATH = ["channels", "feishu"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveFeishuConfig(props: ChannelsProps): Record<string, unknown> {
  const channels = asRecord(props.configForm?.channels);
  return asRecord(channels?.feishu) ?? {};
}

function isConfiguredSecret(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return asRecord(value) !== null;
}

function editableSecretValue(value: unknown): string {
  return typeof value === "string" && value !== REDACTED_SENTINEL ? value : "";
}

function isPreservedSecret(value: unknown): boolean {
  return value === REDACTED_SENTINEL || asRecord(value) !== null;
}

function renderSecretControl(params: {
  id: string;
  value: unknown;
  disabled: boolean;
  placeholder: string;
  onInput: (value: string) => void;
}) {
  const preserved = isPreservedSecret(params.value);
  return html`
    <span class="feishu-secret-control" data-secret-preserved=${String(preserved)}>
      <input
        id=${params.id}
        name=${params.id}
        class="settings-input"
        type="password"
        autocomplete="new-password"
        spellcheck="false"
        placeholder=${params.placeholder}
        .value=${editableSecretValue(params.value)}
        ?disabled=${params.disabled}
        @input=${(event: Event) => params.onInput((event.currentTarget as HTMLInputElement).value)}
      />
      ${preserved
        ? html`
            <span class="feishu-secret-control__preserved" aria-hidden="true">
              <span class="feishu-secret-control__dots">••••••••••••</span>
              <span class="feishu-secret-control__saved"
                >✓ ${t("channels.feishuSetup.secretSaved")}</span
              >
            </span>
          `
        : nothing}
    </span>
  `;
}

function renderSaveStatus(props: ChannelsProps) {
  switch (props.configAutoSaveStatus) {
    case "saving":
      return html`
        <div class="feishu-save-status feishu-save-status--saving" role="status">
          <span class="feishu-save-status__indicator"></span>
          <div>
            <strong>${t("channels.feishuSetup.savingTitle")}</strong>
          </div>
        </div>
      `;
    case "saved":
      return html`
        <div class="feishu-save-status feishu-save-status--saved" role="status">
          <span class="feishu-save-status__check">✓</span>
          <div>
            <strong>${t("channels.feishuSetup.savedTitle")}</strong>
          </div>
        </div>
      `;
    case "error":
      return html`
        <div class="feishu-save-status feishu-save-status--error" role="alert">
          <span class="feishu-save-status__check">!</span>
          <div>
            <strong>${t("channels.feishuSetup.saveFailedTitle")}</strong>
            <span>${t("channels.feishuSetup.saveFailedHelp")}</span>
          </div>
        </div>
      `;
    case "conflict":
      return html`
        <div class="feishu-save-status feishu-save-status--error" role="alert">
          <span class="feishu-save-status__check">!</span>
          <div>
            <strong>${t("channels.feishuSetup.saveConflictTitle")}</strong>
            <span>${t("channels.feishuSetup.saveConflictHelp")}</span>
          </div>
        </div>
      `;
    case "idle":
      return nothing;
  }
}

function patchFeishuField(props: ChannelsProps, field: string, value: unknown) {
  props.onConfigPatch([...FEISHU_CONFIG_PATH, field], value);
  if (resolveFeishuConfig(props).enabled !== true) {
    props.onConfigPatch([...FEISHU_CONFIG_PATH, "enabled"], true);
  }
}

function renderField(params: {
  id: string;
  label: string;
  badge: string;
  help: string;
  control: TemplateResult;
  required?: boolean;
}) {
  return html`
    <label class="feishu-direct-form__field" for=${params.id}>
      <span class="feishu-direct-form__label">
        <span>${params.label}</span>
        <span
          class="feishu-direct-form__badge ${params.required
            ? "feishu-direct-form__badge--required"
            : ""}"
        >
          ${params.badge}
        </span>
      </span>
      ${params.control}
      <span class="feishu-direct-form__help">${params.help}</span>
    </label>
  `;
}

export function renderFeishuDirectConfig(props: ChannelsProps) {
  const config = resolveFeishuConfig(props);
  const appId = typeof config.appId === "string" ? config.appId : "";
  const appSecret = config.appSecret;
  const appSecretConfigured = isConfiguredSecret(appSecret);
  const domain = config.domain === "lark" ? "lark" : "feishu";
  const connectionMode = config.connectionMode === "webhook" ? "webhook" : "websocket";
  const webhookMode = connectionMode === "webhook";
  const verificationTokenConfigured = isConfiguredSecret(config.verificationToken);
  const encryptKeyConfigured = isConfiguredSecret(config.encryptKey);
  const requiredReady =
    appId.trim().length > 0 &&
    appSecretConfigured &&
    (!webhookMode || (verificationTokenConfigured && encryptKeyConfigured));
  const saving = props.configSaving || props.configAutoSaveStatus === "saving";
  const disabled = saving || props.configSchemaLoading || !props.configForm;

  return html`
    <section class="feishu-direct-form" aria-labelledby="feishu-direct-form-title">
      <div class="feishu-direct-form__heading">
        <div>
          <p class="feishu-direct-form__eyebrow">FEISHU CHANNEL</p>
          <h2 id="feishu-direct-form-title">${t("channels.feishuSetup.title")}</h2>
          <p>${t("channels.feishuSetup.subtitle")}</p>
        </div>
        <a class="btn btn--sm" href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
          ${t("channels.feishuSetup.openPlatform")}
        </a>
      </div>

      ${props.configSchemaLoading || !props.configForm
        ? html`<div class="settings-row__desc">${t("channels.config.loadingSchema")}</div>`
        : html`
            <div class="feishu-direct-form__group">
              <div class="feishu-direct-form__group-heading">
                <div>
                  <h3>${t("channels.feishuSetup.credentialsTitle")}</h3>
                  <p>${t("channels.feishuSetup.credentialsHelp")}</p>
                </div>
                <span class="feishu-direct-form__count"
                  >2 ${t("channels.feishuSetup.required")}</span
                >
              </div>
              <div class="feishu-direct-form__grid">
                ${renderField({
                  id: "feishu-app-id",
                  label: "App ID",
                  badge: t("channels.feishuSetup.required"),
                  help: t("channels.feishuSetup.appIdHelp"),
                  required: true,
                  control: html`
                    <input
                      id="feishu-app-id"
                      name="feishu-app-id"
                      class="settings-input"
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      required
                      placeholder="cli_xxxxxxxxxxxxxxxx"
                      .value=${appId}
                      ?disabled=${disabled}
                      @input=${(event: Event) =>
                        patchFeishuField(
                          props,
                          "appId",
                          (event.currentTarget as HTMLInputElement).value,
                        )}
                    />
                  `,
                })}
                ${renderField({
                  id: "feishu-app-secret",
                  label: "App Secret",
                  badge: t("channels.feishuSetup.required"),
                  help: appSecretConfigured
                    ? t("channels.feishuSetup.secretConfiguredHelp")
                    : t("channels.feishuSetup.appSecretHelp"),
                  required: true,
                  control: renderSecretControl({
                    id: "feishu-app-secret",
                    value: appSecret,
                    disabled,
                    placeholder: appSecretConfigured
                      ? t("channels.feishuSetup.secretConfiguredPlaceholder")
                      : t("channels.feishuSetup.requiredPlaceholder"),
                    onInput: (value) => patchFeishuField(props, "appSecret", value),
                  }),
                })}
              </div>
            </div>

            <div class="feishu-direct-form__group feishu-direct-form__group--defaults">
              <div class="feishu-direct-form__group-heading">
                <div>
                  <h3>${t("channels.feishuSetup.defaultsTitle")}</h3>
                  <p>${t("channels.feishuSetup.defaultsHelp")}</p>
                </div>
                <span class="feishu-direct-form__badge"
                  >${t("channels.feishuSetup.hasDefaults")}</span
                >
              </div>
              <div class="feishu-direct-form__grid">
                ${renderField({
                  id: "feishu-domain",
                  label: t("channels.feishuSetup.domain"),
                  badge: t("channels.feishuSetup.defaultFeishu"),
                  help: t("channels.feishuSetup.domainHelp"),
                  control: html`
                    <select
                      id="feishu-domain"
                      name="feishu-domain"
                      .value=${domain}
                      ?disabled=${disabled}
                      @change=${(event: Event) =>
                        patchFeishuField(
                          props,
                          "domain",
                          (event.currentTarget as HTMLSelectElement).value,
                        )}
                    >
                      <option value="feishu">Feishu (China)</option>
                      <option value="lark">Lark (International)</option>
                    </select>
                  `,
                })}
                ${renderField({
                  id: "feishu-connection-mode",
                  label: t("channels.feishuSetup.connectionMode"),
                  badge: t("channels.feishuSetup.defaultWebsocket"),
                  help: webhookMode
                    ? t("channels.feishuSetup.webhookModeHelp")
                    : t("channels.feishuSetup.connectionModeHelp"),
                  control: html`
                    <select
                      id="feishu-connection-mode"
                      name="feishu-connection-mode"
                      .value=${connectionMode}
                      ?disabled=${disabled}
                      @change=${(event: Event) =>
                        patchFeishuField(
                          props,
                          "connectionMode",
                          (event.currentTarget as HTMLSelectElement).value,
                        )}
                    >
                      <option value="websocket">WebSocket</option>
                      <option value="webhook">Webhook</option>
                    </select>
                  `,
                })}
              </div>

              ${webhookMode
                ? html`
                    <div class="feishu-direct-form__conditional">
                      <p class="feishu-direct-form__conditional-title">
                        ${t("channels.feishuSetup.webhookRequiredTitle")}
                      </p>
                      <div class="feishu-direct-form__grid">
                        ${renderField({
                          id: "feishu-verification-token",
                          label: "Verification Token",
                          badge: t("channels.feishuSetup.requiredForWebhook"),
                          help: verificationTokenConfigured
                            ? t("channels.feishuSetup.secretConfiguredHelp")
                            : t("channels.feishuSetup.verificationTokenHelp"),
                          required: true,
                          control: renderSecretControl({
                            id: "feishu-verification-token",
                            value: config.verificationToken,
                            disabled,
                            placeholder: verificationTokenConfigured
                              ? t("channels.feishuSetup.secretConfiguredPlaceholder")
                              : t("channels.feishuSetup.requiredPlaceholder"),
                            onInput: (value) => patchFeishuField(props, "verificationToken", value),
                          }),
                        })}
                        ${renderField({
                          id: "feishu-encrypt-key",
                          label: "Encrypt Key",
                          badge: t("channels.feishuSetup.requiredForWebhook"),
                          help: encryptKeyConfigured
                            ? t("channels.feishuSetup.secretConfiguredHelp")
                            : t("channels.feishuSetup.encryptKeyHelp"),
                          required: true,
                          control: renderSecretControl({
                            id: "feishu-encrypt-key",
                            value: config.encryptKey,
                            disabled,
                            placeholder: encryptKeyConfigured
                              ? t("channels.feishuSetup.secretConfiguredPlaceholder")
                              : t("channels.feishuSetup.requiredPlaceholder"),
                            onInput: (value) => patchFeishuField(props, "encryptKey", value),
                          }),
                        })}
                        ${renderField({
                          id: "feishu-webhook-path",
                          label: "Webhook Path",
                          badge: t("channels.feishuSetup.defaultWebhookPath"),
                          help: t("channels.feishuSetup.webhookPathHelp"),
                          control: html`
                            <input
                              id="feishu-webhook-path"
                              class="settings-input"
                              type="text"
                              spellcheck="false"
                              placeholder="/feishu/events"
                              .value=${typeof config.webhookPath === "string"
                                ? config.webhookPath
                                : "/feishu/events"}
                              ?disabled=${disabled}
                              @input=${(event: Event) =>
                                patchFeishuField(
                                  props,
                                  "webhookPath",
                                  (event.currentTarget as HTMLInputElement).value,
                                )}
                            />
                          `,
                        })}
                      </div>
                    </div>
                  `
                : nothing}
            </div>

            ${renderSaveStatus(props)}
            <div class="feishu-direct-form__actions">
              <div class="feishu-direct-form__readiness" aria-live="polite">
                <span class=${requiredReady ? "is-ready" : ""}></span>
                ${requiredReady
                  ? t("channels.feishuSetup.readyToSave")
                  : t("channels.feishuSetup.completeRequired")}
              </div>
              <div>
                <button
                  type="button"
                  class="btn"
                  ?disabled=${disabled}
                  @click=${() => props.onConfigReload()}
                >
                  ${t("common.reload")}
                </button>
                <button
                  type="button"
                  class="btn primary"
                  ?disabled=${disabled || !props.configFormDirty || !requiredReady}
                  @click=${() => props.onConfigSave()}
                >
                  ${saving ? t("common.saving") : t("channels.feishuSetup.save")}
                </button>
              </div>
            </div>
          `}
    </section>
  `;
}
