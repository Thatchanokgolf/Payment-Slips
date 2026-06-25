// Helper for Netlify Functions (v2, Web-standard Request/Response) to return a
// JSON response with the right content type.
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
