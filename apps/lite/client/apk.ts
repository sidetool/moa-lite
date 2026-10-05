export class ApkBridge {
  async status() { return { available: false }; }
  async registry(): Promise<any> { throw new Error('compatibility_feature_unsupported'); }
  async install(): Promise<any> { throw new Error('compatibility_feature_unsupported'); }
  async call(): Promise<any> { throw new Error('compatibility_feature_unsupported'); }
  async preferences(): Promise<any> { throw new Error('compatibility_feature_unsupported'); }
  async remove() {}
}
export const apkIconUrl = () => undefined;
