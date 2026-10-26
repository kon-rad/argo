/** An OpenAI-compatible streaming reply, as every summary-chain provider sends it. */
export const sse = (text: string, usage = { prompt_tokens: 120, completion_tokens: 40 }) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
