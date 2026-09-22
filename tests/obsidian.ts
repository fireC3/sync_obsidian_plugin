export const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
export class TFile { constructor(public path: string) {} get extension() { return this.path.split('.').pop(); } }
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class Notice {}
export type App = any;
export let beforeRequest: ((options: any) => Promise<void>) | undefined;
export function interceptRequest(hook?: (options: any) => Promise<void>) { beforeRequest = hook; }
export async function requestUrl(options: any): Promise<any> {
  await beforeRequest?.(options);
  const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body });
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  return { status: response.status, arrayBuffer, text, get json() { return JSON.parse(text); } };
}
