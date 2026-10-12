// The <base href="./"> keeps URLs relative to the app directory, including a
// server-provided /api URL. Retain OpenLayers' literal {z}/{x}/{y} placeholders.
export function appPath(path) {
  return './' + path.replace(/^\/+/, '').replace(/^\.\//, '');
}
