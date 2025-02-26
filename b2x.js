// rbxConverter.js
//
// This module exports a single async function: convertBinaryToXML()
// It reads an ArrayBuffer containing a Roblox binary model file and returns
// a string containing the corresponding XML model.
// It is written as an ES module so you can load it from other script tags using:
//    <script type="module" src="rbxConverter.js"></script>
// and then import { convertBinaryToXML } from "./rbxConverter.js";

export async function convertBinaryToXML(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  
  // --- Validate Header (32 bytes) ---
  // The first 8 bytes must be the magic string "<roblox!"
  const magic = decodeText(new Uint8Array(buffer, offset, 8));
  if (magic !== '<roblox!') {
    throw new Error('Invalid file format: missing magic header');
  }
  offset += 32; // Skip header
  
  // --- Create a model representation ---
  const model = {
    meta: [],              // Array of { key, value }
    sharedStrings: new Map(), // Map from md5 to string
    instances: new Map(),     // Map from referent (string) to instance object
    instOrder: [],            // Ordered list of instances (for XML output)
    parentMapping: []         // Array of { child, parent } mappings from PRNT chunk
  };
  
  // --- Process Chunks ---
  while (offset < buffer.byteLength) {
    // Peek at the next 4 bytes for chunk name
    const chunkName = decodeText(new Uint8Array(buffer, offset, 4));
    // The END chunk (name "END") signifies termination.
    if (chunkName.trim() === "END") {
      // Skip the END chunk header (16 bytes) plus its magic value (if any)
      offset += 16;
      break;
    }
    
    // Read chunk header (16 bytes)
    const currentChunkName = decodeText(new Uint8Array(buffer, offset, 4));
    offset += 4;
    const compLen = view.getUint32(offset, true);
    offset += 4;
    const uncompLen = view.getUint32(offset, true);
    offset += 4;
    offset += 4; // reserved
    
    let chunkData;
    if (compLen === 0) {
      // Uncompressed chunk data
      chunkData = buffer.slice(offset, offset + uncompLen);
    } else {
      // TODO: Handle decompression (LZ4 or ZSTD) if needed.
      throw new Error('Compressed chunks are not yet supported');
    }
    offset += uncompLen;
    
    // Process each known chunk type:
    switch (currentChunkName.trim()) {
      case "META":
        parseMETA(chunkData, model);
        break;
      case "SSTR":
        parseSSTR(chunkData, model);
        break;
      case "INST":
        parseINST(chunkData, model);
        break;
      case "PROP":
        parsePROP(chunkData, model);
        break;
      case "PRNT":
        parsePRNT(chunkData, model);
        break;
      default:
        console.warn("Unknown chunk type:", currentChunkName);
        break;
    }
  }
  
  // --- Build Parent/Child Relationships ---
  assignParentChild(model);
  
  // --- Convert model to XML string ---
  const xml = modelToXML(model);
  return xml;
}

/* ===== Helper Functions ===== */

// Decode a UTF-8 string from a Uint8Array.
function decodeText(uint8Array) {
  return new TextDecoder("utf-8").decode(uint8Array);
}

// Reads a length-prefixed string from a DataView starting at offset.
// The length is a 32-bit unsigned integer (little-endian).
function readString(view, buffer, offset) {
  const len = view.getUint32(offset, true);
  offset += 4;
  const str = decodeText(new Uint8Array(buffer, offset, len));
  offset += len;
  return { str, offset };
}

/* --- Chunk Parsers --- */

// META chunk: contains metadata key-value pairs.
function parseMETA(chunkBuffer, model) {
  const view = new DataView(chunkBuffer);
  let offset = 0;
  const entryCount = view.getUint32(offset, true);
  offset += 4;
  for (let i = 0; i < entryCount; i++) {
    const keyRes = readString(view, chunkBuffer, offset);
    const key = keyRes.str;
    offset = keyRes.offset;
    const valRes = readString(view, chunkBuffer, offset);
    const value = valRes.str;
    offset = valRes.offset;
    model.meta.push({ key, value });
  }
}

// SSTR chunk: contains shared strings to reduce duplication.
function parseSSTR(chunkBuffer, model) {
  const view = new DataView(chunkBuffer);
  let offset = 0;
  const version = view.getUint32(offset, true);
  offset += 4;
  const count = view.getUint32(offset, true);
  offset += 4;
  for (let i = 0; i < count; i++) {
    // MD5 hash: 16 bytes.
    const md5Bytes = new Uint8Array(chunkBuffer, offset, 16);
    const md5 = Array.from(md5Bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    offset += 16;
    const strRes = readString(view, chunkBuffer, offset);
    const sharedStr = strRes.str;
    offset = strRes.offset;
    model.sharedStrings.set(md5, sharedStr);
  }
}

// INST chunk: defines instances (each becomes an <Item> in XML).
function parseINST(chunkBuffer, model) {
  const view = new DataView(chunkBuffer);
  let offset = 0;
  // Read ClassID (u32)
  const classID = view.getUint32(offset, true);
  offset += 4;
  // Read class name (length-prefixed)
  const classNameRes = readString(view, chunkBuffer, offset);
  const className = classNameRes.str;
  offset = classNameRes.offset;
  // Read object format (u8)
  const objectFormat = view.getUint8(offset);
  offset += 1;
  // Read instance count (u32)
  const instanceCount = view.getUint32(offset, true);
  offset += 4;
  
  // For each instance, read its referent (32-bit int).
  for (let i = 0; i < instanceCount; i++) {
    const referent = view.getInt32(offset, true);
    offset += 4;
    if (objectFormat === 1) {
      // For service instances, there is an extra service marker byte.
      offset += 1;
    }
    const inst = {
      referent: referent.toString(),
      className,
      properties: {},
      children: [],
      parent: null
    };
    model.instances.set(inst.referent, inst);
    model.instOrder.push(inst);
  }
}

// PROP chunk: defines property values for instances.
// The property applies to all instances of a given class.
function parsePROP(chunkBuffer, model) {
  const view = new DataView(chunkBuffer);
  let offset = 0;
  // Read ClassID for which these properties apply.
  const classID = view.getUint32(offset, true);
  offset += 4;
  // Read property name (length-prefixed).
  const propNameRes = readString(view, chunkBuffer, offset);
  const propName = propNameRes.str;
  offset = propNameRes.offset;
  // Read type ID (u8).
  const typeID = view.getUint8(offset);
  offset += 1;
  
  // Determine the instances to which this property applies.
  // (In a full implementation, a mapping of classID to instances would be maintained.)
  const instances = Array.from(model.instances.values()).filter(inst => 
    inst.className === getClassNameFromID(model, classID)
  );
  const valueCount = instances.length;
  
  // Read each value based on the typeID.
  const values = [];
  for (let i = 0; i < valueCount; i++) {
    const parseRes = parseValueByType(view, chunkBuffer, offset, typeID);
    values.push(parseRes.value);
    offset = parseRes.offset;
  }
  
  // Assign the property to each instance in order.
  for (let i = 0; i < instances.length; i++) {
    instances[i].properties[propName] = { typeID, value: values[i] };
  }
}

// PRNT chunk: defines parent-child relationships.
function parsePRNT(chunkBuffer, model) {
  const view = new DataView(chunkBuffer);
  let offset = 0;
  const version = view.getUint8(offset);
  offset += 1;
  const count = view.getUint32(offset, true);
  offset += 4;
  const childReferents = [];
  const parentReferents = [];
  for (let i = 0; i < count; i++) {
    const child = view.getInt32(offset, true);
    offset += 4;
    childReferents.push(child.toString());
  }
  for (let i = 0; i < count; i++) {
    const parent = view.getInt32(offset, true);
    offset += 4;
    parentReferents.push(parent.toString());
  }
  for (let i = 0; i < count; i++) {
    model.parentMapping.push({
      child: childReferents[i],
      parent: parentReferents[i] === "-1" ? null : parentReferents[i]
    });
  }
}

/* --- Value Parsing for PROP Chunks --- */

// Parses a single value based on its typeID.
function parseValueByType(view, buffer, offset, typeID) {
  let value, newOffset = offset;
  switch(typeID) {
    case 0x01: { // String
      const res = readString(view, buffer, newOffset);
      value = res.str;
      newOffset = res.offset;
      break;
    }
    case 0x02: { // Bool
      value = view.getUint8(newOffset) === 1;
      newOffset += 1;
      break;
    }
    case 0x03: { // Int32
      value = view.getInt32(newOffset, true);
      newOffset += 4;
      break;
    }
    case 0x04: { // Float32
      value = view.getFloat32(newOffset, true);
      newOffset += 4;
      break;
    }
    case 0x05: { // Float64
      value = view.getFloat64(newOffset, true);
      newOffset += 8;
      break;
    }
    // Additional cases for UDim, UDim2, Ray, etc. can be added here.
    default: {
      console.warn("Unsupported typeID", typeID);
      value = null;
      newOffset += 4; // Skip a default number of bytes.
      break;
    }
  }
  return { value, offset: newOffset };
}

// Dummy helper: in a full implementation, the mapping of classID to className
// would be built from the INST chunks. Here we simply return the first instance's className.
function getClassNameFromID(model, classID) {
  for (const inst of model.instances.values()) {
    if (inst.className) return inst.className;
  }
  return "Unknown";
}

// Assign parent-child relationships based on the PRNT chunk data.
function assignParentChild(model) {
  for (const mapping of model.parentMapping) {
    if (mapping.parent !== null) {
      const parentInst = model.instances.get(mapping.parent);
      const childInst = model.instances.get(mapping.child);
      if (parentInst && childInst) {
        parentInst.children.push(childInst);
        childInst.parent = parentInst;
      }
    }
  }
}

/* --- XML Generation --- */

// Convert the in-memory model to an XML string conforming to Roblox’s XML model format.
function modelToXML(model) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="utf-8"?>`);
  parts.push(`<roblox version="4">`);
  
  // Output Meta elements.
  for (const meta of model.meta) {
    parts.push(`  <Meta name="${escapeXML(meta.key)}">${escapeXML(meta.value)}</Meta>`);
  }
  
  // Output SharedStrings if available.
  if (model.sharedStrings.size > 0) {
    parts.push(`  <SharedStrings>`);
    for (const [md5, value] of model.sharedStrings.entries()) {
      parts.push(`    <SharedString md5="${md5}">${escapeXML(value)}</SharedString>`);
    }
    parts.push(`  </SharedStrings>`);
  }
  
  // Output each instance as an Item.
  for (const inst of model.instOrder) {
    parts.push(`  <Item class="${escapeXML(inst.className)}" referent="${escapeXML(inst.referent)}">`);
    parts.push(`    <Properties>`);
    for (const [propName, prop] of Object.entries(inst.properties)) {
      parts.push(`      ${propertyToXML(propName, prop)}`);
    }
    parts.push(`    </Properties>`);
    parts.push(`  </Item>`);
  }
  
  parts.push(`</roblox>`);
  return parts.join("\n");
}

// Convert a property (name and its parsed value) to an XML element string.
// In a complete converter, this would branch based on type and generate child elements
// for complex types (e.g. CoordinateFrame, Color3, etc.). Here we show a simplified mapping.
function propertyToXML(name, prop) {
  const elementName = getXMLElementNameForType(prop.typeID, name);
  return `<${elementName} name="${escapeXML(name)}">${escapeXML(String(prop.value))}</${elementName}>`;
}

// Map binary type IDs to XML element names.
// Extend this mapping as needed.
function getXMLElementNameForType(typeID, propName) {
  switch(typeID) {
    case 0x01: return "string";
    case 0x02: return "bool";
    case 0x03: return "int";
    case 0x04: return "float";
    case 0x05: return "double";
    // Additional mappings for UDim, UDim2, etc.
    default: return "string";
  }
}

// Escape special XML characters.
function escapeXML(str) {
  return str.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
}
