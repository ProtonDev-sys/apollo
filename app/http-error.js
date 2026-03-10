function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createAbortError(message = 'Operation aborted.', statusCode = 409) {
  const error = createHttpError(statusCode, message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error) {
  return Boolean(
    error &&
      (error.name === 'AbortError' ||
        error.code === 'ABORT_ERR' ||
        error.code === 'ERR_ABORTED')
  );
}

module.exports = {
  createHttpError,
  createAbortError,
  isAbortError
};
