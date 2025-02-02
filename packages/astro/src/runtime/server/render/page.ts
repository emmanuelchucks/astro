import type { SSRResult } from '../../../@types/astro';
import type { ComponentIterable } from './component';
import type { AstroComponentFactory } from './index';

import { isHTMLString } from '../escape.js';
import { createResponse } from '../response.js';
import { isAstroComponent, isAstroComponentFactory, renderAstroComponent } from './astro.js';
import { chunkToByteArray, encoder, HTMLParts } from './common.js';
import { renderComponent } from './component.js';
import { maybeRenderHead } from './head.js';

const needsHeadRenderingSymbol = Symbol.for('astro.needsHeadRendering');

type NonAstroPageComponent = {
	name: string;
	[needsHeadRenderingSymbol]: boolean;
};

function nonAstroPageNeedsHeadInjection(pageComponent: NonAstroPageComponent): boolean {
	return needsHeadRenderingSymbol in pageComponent && !!pageComponent[needsHeadRenderingSymbol];
}

async function iterableToHTMLBytes(
	result: SSRResult,
	iterable: ComponentIterable,
	onDocTypeInjection?: (parts: HTMLParts) => Promise<void>
): Promise<Uint8Array> {
	const parts = new HTMLParts();
	let i = 0;
	for await (const chunk of iterable) {
		if (isHTMLString(chunk)) {
			if (i === 0) {
				if (!/<!doctype html/i.test(String(chunk))) {
					parts.append('<!DOCTYPE html>\n', result);
					if (onDocTypeInjection) {
						await onDocTypeInjection(parts);
					}
				}
			}
		}
		parts.append(chunk, result);
	}
	return parts.toArrayBuffer();
}

export async function renderPage(
	result: SSRResult,
	componentFactory: AstroComponentFactory | NonAstroPageComponent,
	props: any,
	children: any,
	streaming: boolean
): Promise<Response> {
	if (!isAstroComponentFactory(componentFactory)) {
		const pageProps: Record<string, any> = { ...(props ?? {}), 'server:root': true };
		const output = await renderComponent(
			result,
			componentFactory.name,
			componentFactory,
			pageProps,
			null
		);

		// Accumulate the HTML string and append the head if necessary.
		const bytes = await iterableToHTMLBytes(result, output, async (parts) => {
			if (nonAstroPageNeedsHeadInjection(componentFactory)) {
				for await (let chunk of maybeRenderHead(result)) {
					parts.append(chunk, result);
				}
			}
		});

		return new Response(bytes, {
			headers: new Headers([
				['Content-Type', 'text/html; charset=utf-8'],
				['Content-Length', bytes.byteLength.toString()],
			]),
		});
	}
	const factoryReturnValue = await componentFactory(result, props, children);

	if (isAstroComponent(factoryReturnValue)) {
		let iterable = renderAstroComponent(factoryReturnValue);
		let init = result.response;
		let headers = new Headers(init.headers);
		let body: BodyInit;

		if (streaming) {
			body = new ReadableStream({
				start(controller) {
					async function read() {
						let i = 0;
						try {
							for await (const chunk of iterable) {
								if (isHTMLString(chunk)) {
									if (i === 0) {
										if (!/<!doctype html/i.test(String(chunk))) {
											controller.enqueue(encoder.encode('<!DOCTYPE html>\n'));
										}
									}
								}

								const bytes = chunkToByteArray(result, chunk);
								controller.enqueue(bytes);
								i++;
							}
							controller.close();
						} catch (e) {
							controller.error(e);
						}
					}
					read();
				},
			});
		} else {
			body = await iterableToHTMLBytes(result, iterable);
			headers.set('Content-Length', body.byteLength.toString());
		}

		let response = createResponse(body, { ...init, headers });
		return response;
	}

	// We double check if the file return a Response
	if (!(factoryReturnValue instanceof Response)) {
		throw new Error('Only instance of Response can be returned from an Astro file');
	}

	return factoryReturnValue;
}
