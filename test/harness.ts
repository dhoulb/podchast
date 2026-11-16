// Local test worker: POST HTML, get the extracted article back.
import { extractArticle, chunkText } from "../src/extract";
import { mp3Duration } from "../src/tts";
export default {
	async fetch(req: Request) {
		const a = await extractArticle(new Response(req.body, { headers: { "content-type": "text/html" } }), "https://example.com/cats");
		const chunks = chunkText(a.text + "\n\n" + "Long sentence here. ".repeat(300), 2500);
		const mp3 = new Uint8Array((48000 / 8) * 10);
		mp3.set([0xff, 0xf3, 0x64]);
		return new Response(
			JSON.stringify({ ...a, text: undefined }, null, 1) + "\n\n" + a.text + "\n\nchunks: " + chunks.map((c) => c.length).join(",") + "\nduration (expect 10): " + mp3Duration(mp3),
		);
	},
};
