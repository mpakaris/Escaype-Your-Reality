"use strict";

// Schema validator for cartridges and JSONL catalog chunks
// Uses Ajv v8. Keep root JSON Schema as regular JSON, not JSONL.

import Ajv from "ajv/dist/2020.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let addFormatsLoaded = false;
let _ajv = null;
let _schema = null;
let _rootValidator = null; // compiled function
const _subValidators = new Map(); // defName -> compiled function

const SCHEMA_FILE = path.resolve(
  __dirname,
  "../schema/v1/cartridge.schema.json"
);

function loadSchema() {
  if (_schema) return _schema;
  const raw = fs.readFileSync(SCHEMA_FILE, "utf8");
  _schema = JSON.parse(raw);
  return _schema;
}

function getSchemaId() {
  const s = loadSchema();
  return s.$id || "cartridge.schema.v1";
}

async function ensureFormats(ajv) {
  if (addFormatsLoaded) return;
  try {
    const mod = await import("ajv-formats");
    const addFormats = mod.default || mod;
    addFormats(ajv);
  } catch (_) {
    // optional
  }
  addFormatsLoaded = true;
}

function createAjvSync() {
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
    useDefaults: false,
    removeAdditional: false,
  });
  return ajv;
}

function getAjv() {
  if (_ajv) return _ajv;
  const ajv = createAjvSync();
  const schema = loadSchema();
  // best-effort load formats without awaiting (will be added on next tick if available)
  ensureFormats(ajv);
  ajv.addSchema(schema, schema.$id || "cartridge.schema.v1");
  _ajv = ajv;
  return _ajv;
}

function getRootValidator() {
  if (_rootValidator) return _rootValidator;
  const ajv = getAjv();
  const schema = loadSchema();
  const id = getSchemaId();
  const validate = ajv.getSchema(id) || ajv.compile(schema);
  _rootValidator = validate;
  return _rootValidator;
}

function getSubValidator(defName) {
  if (_subValidators.has(defName)) return _subValidators.get(defName);
  const ajv = getAjv();
  const id = getSchemaId();
  const ref = `${id}#/$defs/${defName}`;
  let validate = ajv.getSchema(ref);
  if (!validate) {
    validate = ajv.compile({ $ref: ref });
  }
  _subValidators.set(defName, validate);
  return validate;
}

function formatErrors(errors) {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => ({
    path: e.instancePath || "/",
    keyword: e.keyword,
    message: e.message,
    params: e.params,
    schemaPath: e.schemaPath,
  }));
}

// Validate a full cartridge object against the root schema
function validateCartridge(data) {
  const validate = getRootValidator();
  const ok = validate(data);
  return { ok, errors: ok ? [] : formatErrors(validate.errors) };
}

// Throw on invalid cartridge
function assertValidCartridge(data) {
  const { ok, errors } = validateCartridge(data);
  if (!ok) {
    const msg = errors.map((e) => `${e.path} ${e.message}`).join("; ");
    const err = new Error(`Cartridge validation failed: ${msg}`);
    err.details = errors;
    throw err;
  }
}

// Validate a single JSON object against a named $defs subschema
// Example: defName = 'location' | 'object' | 'npc' | 'item' | 'requirement' | 'effects' | 'response' | 'sequence'
function validateByDef(defName, data) {
  const validate = getSubValidator(defName);
  const ok = validate(data);
  return { ok, errors: ok ? [] : formatErrors(validate.errors) };
}

// Utility: validate an array of JSONL-parsed objects against a subschema
function validateJsonlArray(defName, arr) {
  const validate = getSubValidator(defName);
  const errors = [];
  for (let i = 0; i < arr.length; i += 1) {
    const obj = arr[i];
    const ok = validate(obj);
    if (!ok) {
      const entryErrors = formatErrors(validate.errors).map((e) => ({
        index: i,
        ...e,
      }));
      errors.push(...entryErrors);
    }
  }
  return { ok: errors.length === 0, errors };
}

export {
  // Expose low-levels for tests
  getAjv as _getAjv,
  getRootValidator as _getRootValidator,
  assertValidCartridge,
  loadSchema,
  SCHEMA_FILE,
  validateByDef,
  validateCartridge,
  validateJsonlArray,
};
