export function mkdirSync() {}
const unavailable = () => { throw new Error('server_feature_unavailable'); };
export const readFile = unavailable, realpath = unavailable, stat = unavailable, spawn = unavailable;
export class DatabaseSync { constructor() { unavailable(); } }
export default { join: (...parts: string[]) => parts.join('/') };
