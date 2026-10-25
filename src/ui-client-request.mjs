// The browser and tests share the same request implementation.
export function createClientRequest(sessionToken, fetch) {

  const sessionHeaders = { 'X-Revisor-Session': sessionToken };

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { ...sessionHeaders, ...(options.headers || {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  return request;
}

export const CLIENT_REQUEST_SOURCE = `const request = (${createClientRequest.toString()})(sessionToken, fetch);`;
