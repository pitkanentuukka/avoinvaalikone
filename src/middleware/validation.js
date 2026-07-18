/**
 * Input validation utilities and middleware
 */

const UUID_REGEX  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate if a string is a valid UUID v4
 */
function isValidUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Validate if a string is within max length
 */
function isValidLength(value, maxLength = 500) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Validate if a value is an integer in range
 */
function isValidRange(value, min, max) {
  const num = parseInt(value, 10);
  return !isNaN(num) && num >= min && num <= max;
}

/**
 * Validate that a URL uses http:// or https:// (rejects javascript:, data:, etc.)
 */
function isValidUrl(value) {
  return typeof value === 'string' && (value.startsWith('https://') || value.startsWith('http://'));
}

/**
 * Validate a basic email address format
 */
function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_REGEX.test(value);
}

/**
 * Validate array of UUIDs from query parameter
 */
function validateUUIDArray(arr) {
  if (!Array.isArray(arr)) return false;
  return arr.every(id => isValidUUID(id));
}

/**
 * Middleware to validate UUID route parameters
 */
function validateUUIDParam(paramName) {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!isValidUUID(value)) {
      return res.status(400).json({ error: `Virheellinen tunnus: ${paramName}` });
    }
    next();
  };
}

/**
 * Middleware to validate string length in request body
 */
function validateBodyField(fieldName, maxLength = 500, required = true) {
  return (req, res, next) => {
    const value = req.body[fieldName];
    
    if (required && (!value || typeof value !== 'string' || !value.trim())) {
      return res.status(400).json({ error: `Kenttä vaaditaan: ${fieldName}` });
    }
    
    if (value && !isValidLength(value, maxLength)) {
      return res.status(400).json({ 
        error: `Kenttä '${fieldName}' on liian pitkä (maksimi: ${maxLength} merkkiä)` 
      });
    }
    
    next();
  };
}

module.exports = {
  isValidUUID,
  isValidLength,
  isValidRange,
  isValidUrl,
  isValidEmail,
  validateUUIDArray,
  validateUUIDParam,
  validateBodyField,
};
