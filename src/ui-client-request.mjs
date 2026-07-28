// Browser-side helper source shared by every Revisor UI page. The UI session
// token never leaves the page, so each request carries it as a header instead
// of the local workflow API token.
export const CLIENT_REQUEST_SOURCE = `
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
`;
