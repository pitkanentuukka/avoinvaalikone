const fs = require("fs");
const path = require("path");

const config = fs.readFileSync(
  path.join(__dirname, "../../vaalikone-frontend/nginx.conf"), "utf8"
).replace(/#[^\n]*/g, "");

// nginx considers regex locations after the longest prefix match unless that
// prefix has ^~. Without it, /api/candidates/me/bad.png (and future API routes
// ending in asset extensions) goes to the static handler instead of the API.
test("the API proxy prefix takes precedence over static-asset regex locations", () => {
  const apiLocation = config.match(/\blocation\s+(?:(\^~)\s+)?\/api\/\s*\{([^{}]*)\}/);
  expect(apiLocation).not.toBeNull();
  expect(apiLocation[1]).toBe("^~");
  expect(apiLocation[2]).toMatch(/\bproxy_pass\s+\$backend_upstream\s*;/);
});
