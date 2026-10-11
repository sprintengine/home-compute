import assert from "node:assert/strict";
import test from "node:test";
import { createRedactor, redactValue, secretValues } from "../src/redact.mjs";

const job = {
  id: "harmonie",
  task: {
    image: "x",
    requiredEnv: ["S3_BUCKET", "S3_ENDPOINT_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "FORCE5_SIDECARS"],
    passEnv: ["AWS_REGION", "ECMWF_SOURCE"],
  },
};
const environment = {
  S3_BUCKET: "forecast",
  S3_ENDPOINT_URL: "https://0123456789abcdef.r2.cloudflarestorage.com",
  AWS_ACCESS_KEY_ID: "0123456789abcdef0123",
  AWS_SECRET_ACCESS_KEY: "s3cr3t-value-with/slash",
  FORCE5_SIDECARS: "0",
  AWS_REGION: "auto",
  ECMWF_SOURCE: "ecmwf",
};

test("the values a job is given are redacted when they are credentials or locators", () => {
  const values = secretValues([job], environment, ["api-token-123456"]);
  assert.ok(values.includes("s3cr3t-value-with/slash"));
  assert.ok(values.includes("0123456789abcdef0123"));
  assert.ok(values.includes("https://0123456789abcdef.r2.cloudflarestorage.com"));
  assert.ok(values.includes("api-token-123456"));
  assert.ok(!values.includes("0") && !values.includes("auto") && !values.includes("ecmwf") && !values.includes("forecast"),
    "short, ordinary values would only mangle the log");

  const redact = createRedactor(values);
  const text = redact([
    "key s3cr3t-value-with/slash and id 0123456789abcdef0123",
    "PUT https://0123456789abcdef.r2.cloudflarestorage.com/forecast/latest.json",
    "ecmwf run 0 with 4 workers in auto",
  ].join("\n"));
  assert.doesNotMatch(text, /s3cr3t|0123456789abcdef/);
  assert.match(text, /ecmwf run 0 with 4 workers in auto/);
});

test("credential shapes are redacted whatever the environment holds", () => {
  const redact = createRedactor([]);
  const cases = [
    ["AKIAIOSFODNN7EXAMPLE was used", /AKIA/],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", /wJalr/],
    ['{"token": "abc.def.ghi"}', /abc\.def/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload", /eyJ/],
    ["GET https://bucket.s3.amazonaws.com/a?X-Amz-Credential=AKIA%2F&X-Amz-Signature=deadbeef01", /deadbeef|AKIA%2F/],
    ["postgres://admin:hunter22@db.internal/forecast", /hunter22/],
  ];
  for (const [input, leak] of cases) assert.doesNotMatch(redact(input), leak, input);
  assert.equal(redact("Downloads complete. 73 frames"), "Downloads complete. 73 frames");
});

test("redactValue keeps a report's shape", () => {
  const redact = createRedactor(["supersecret"]);
  assert.deepEqual(redactValue({ event: "x", error: "used supersecret", seconds: 3, nested: ["supersecret"] }, redact),
    { event: "x", error: "used <redacted>", seconds: 3, nested: ["<redacted>"] });
});
