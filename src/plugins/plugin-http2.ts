/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {EventEmitter} from 'events';
// This is imported only for types. Generated .js file should NOT load 'http2'.
// `http2` must be used only in type annotations, not in expressions.
import * as http2 from 'http2';
import * as shimmer from 'shimmer';
import {URL} from 'url';

import {RootSpanOptions, TraceAgent} from '../plugin-types';

function getSpanName(authority: string|URL): string {
  if (typeof authority === 'string') {
    authority = new URL(authority);
  }
  return authority.hostname;
}

function extractMethodName(headers?: http2.OutgoingHttpHeaders): string {
  if (headers && headers[':method']) {
    return headers[':method'] as string;
  }
  return 'GET';
}

function extractPath(headers?: http2.OutgoingHttpHeaders): string {
  if (headers && headers[':path']) {
    return headers[':path'] as string;
  }
  return '/';
}

function extractUrl(
    authority: string|URL, headers?: http2.OutgoingHttpHeaders): string {
  if (typeof authority === 'string') {
    authority = new URL(authority);
  }
  return `${authority.origin}${extractPath(headers)}`;
}

function isTraceAgentRequest(
    headers: http2.OutgoingHttpHeaders|undefined, api: TraceAgent): boolean {
  return !!headers && !!headers[api.constants.TRACE_AGENT_REQUEST_HEADER];
}

function makeRequestTrace(
    session: http2.ClientHttp2Session, request: typeof session.request,
    authority: string|URL, api: TraceAgent): typeof session.request {
  return function(
             this: http2.Http2Session,
             headers?: http2.OutgoingHttpHeaders): http2.ClientHttp2Stream {
    // Create new headers so that the object passed in by the client is not
    // modified.
    const newHeaders: http2.OutgoingHttpHeaders =
        Object.assign({}, headers || {});

    // Don't trace ourselves lest we get into infinite loops.
    // Note: this would not be a problem if we guarantee buffering of trace api
    // calls. If there is no buffering then each trace is an http call which
    // will get a trace which will be an http call.
    //
    // TraceWriter uses http1 so this check is not needed at the moment. But
    // add the check anyway for the potential migration to http2 in the
    // future.
    if (isTraceAgentRequest(newHeaders, api)) {
      return request.apply(this, arguments);
    }

    const requestLifecycleSpan =
        api.createChildSpan({name: getSpanName(authority)});
    if (!requestLifecycleSpan) {
      return request.apply(this, arguments);
    }
    // Node sets the :method pseudo-header to GET if not set by client.
    requestLifecycleSpan.addLabel(
        api.labels.HTTP_METHOD_LABEL_KEY, extractMethodName(newHeaders));
    requestLifecycleSpan.addLabel(
        api.labels.HTTP_URL_LABEL_KEY, extractUrl(authority, newHeaders));
    newHeaders[api.constants.TRACE_CONTEXT_HEADER_NAME] =
        requestLifecycleSpan.getTraceContext();
    const stream: http2.ClientHttp2Stream = request.call(
        this, newHeaders, ...Array.prototype.slice.call(arguments, 1));
    api.wrapEmitter(stream);

    let numBytes = 0;
    let listenerAttached = false;
    stream
        .on('response',
            (headers) => {
              requestLifecycleSpan.addLabel(
                  api.labels.HTTP_RESPONSE_CODE_LABEL_KEY, headers[':status']);
            })
        .on('end',
            () => {
              requestLifecycleSpan.addLabel(
                  api.labels.HTTP_RESPONSE_SIZE_LABEL_KEY, numBytes);
              requestLifecycleSpan.endSpan();
            })
        .on('error', (err: Error) => {
          if (err) {
            requestLifecycleSpan.addLabel(
                api.labels.ERROR_DETAILS_NAME, err.name);
            requestLifecycleSpan.addLabel(
                api.labels.ERROR_DETAILS_MESSAGE, err.message);
          }
          requestLifecycleSpan.endSpan();
        });
    // Streams returned by Http2Session#request are yielded in paused mode.
    // Attaching a 'data' listener to the stream will switch it to flowing
    // mode which could cause the stream to drain before the calling
    // framework has a chance to attach their own listeners. To avoid this,
    // we attach our listener lazily. This approach to tracking data size
    // will not observe data read by explicitly calling `read` on the
    // request. We expect this to be very uncommon as it is not mentioned in
    // any of the official documentation.
    shimmer.wrap(
        stream, 'on',
        (on: (this: EventEmitter, eventName: {}, listener: Function) =>
             EventEmitter) => {
          return function(this: http2.ClientHttp2Stream, eventName: {}) {
            if (eventName === 'data' && !listenerAttached) {
              listenerAttached = true;
              on.call(this, 'data', (chunk: Buffer|string) => {
                numBytes += chunk.length;
              });
            }
            return on.apply(this, arguments);
          };
        });
    return stream;
  };
}

function patchClientHttp2Session(
    session: http2.ClientHttp2Session, authority: string|URL,
    api: TraceAgent): void {
  api.wrapEmitter(session);
  shimmer.wrap(
      session, 'request',
      (request: typeof session.request) =>
          makeRequestTrace(session, request, authority, api));
}

function constructUrl(headers: http2.IncomingHttpHeaders): string {
  // :method, :scheme, and :path are mandatory in http2 spec:
  // https://tools.ietf.org/html/rfc7540#section-8.1.2.3
  const protocol = headers[':scheme'] as string;
  const host = headers[':authority'] || headers['host'] || 'localhost';
  const url = new URL(`${protocol}://${host}`);
  url.host = host as string;
  url.pathname = headers[':path'] as string;
  return url.toString();
}

function constructStatusCode(headers?: http2.OutgoingHttpHeaders): number {
  let status: number|undefined;
  if (headers) {
    const statusVal = headers[':status'] as string | number | undefined;
    if (statusVal) {
      status = Number(statusVal);
    }
  }
  return status || 200;
}

function patchHttp2Server(
    server: http2.Http2Server|http2.Http2SecureServer, api: TraceAgent): void {
  server.on('stream', (stream, headers, flags) => {
    const reqPath: string = headers[':path'] as string;
    const options: RootSpanOptions = {
      name: reqPath,
      traceContext: headers[api.constants.TRACE_CONTEXT_HEADER_NAME] as string |
          undefined,
      url: reqPath,
    };
    api.runInRootSpan(options, (rootSpan) => {
      if (!rootSpan) return;

      api.wrapEmitter(stream);

      const responseTraceContext =
          api.getResponseTraceContext(options.traceContext || null, !!rootSpan);
      if (responseTraceContext) {
        const outHeaders: http2.OutgoingHttpHeaders = {};
        outHeaders[api.constants.TRACE_CONTEXT_HEADER_NAME] =
            responseTraceContext;
        stream.additionalHeaders(outHeaders);
      }

      rootSpan.addLabel(api.labels.HTTP_METHOD_LABEL_KEY, headers[':method']);
      rootSpan.addLabel(api.labels.HTTP_URL_LABEL_KEY, constructUrl(headers));
      rootSpan.addLabel(
          api.labels.HTTP_SOURCE_IP, stream.session.socket.remoteAddress);

      let isResponseCodeLabelAdded = false;
      const addResponseCodeLabel = (headers?: http2.OutgoingHttpHeaders) => {
        if (isResponseCodeLabelAdded) return;
        isResponseCodeLabelAdded = true;
        rootSpan.addLabel(
            api.labels.HTTP_RESPONSE_CODE_LABEL_KEY,
            constructStatusCode(headers));
      };

      shimmer.wrap(
          stream, 'respond',
          (respond: typeof stream.respond): typeof stream.respond => {
            return function(this: http2.ServerHttp2Stream, headers?) {
              addResponseCodeLabel(headers);
              return respond.apply(this, arguments);
            };
          });
      shimmer.wrap(
          stream, 'respondWithFD',
          (respondWithFD: typeof stream.respondWithFD):
              typeof stream.respondWithFD => {
            return function(this: http2.ServerHttp2Stream, fd, headers?) {
              addResponseCodeLabel(headers);
              return respondWithFD.apply(this, arguments);
            };
          });
      shimmer.wrap(
          stream, 'respondWithFile',
          (respondWithFile: typeof stream.respondWithFile):
              typeof stream.respondWithFile => {
            return function(this: http2.ServerHttp2Stream, path, headers?) {
              addResponseCodeLabel(headers);
              return respondWithFile.apply(this, arguments);
            };
          });
      // `stream.end()` is sometimes called multiple times. A span should be
      // ended only once.
      let isSpanEnded = false;
      shimmer.wrap(
          stream, 'end', (end: typeof stream.end): typeof stream.end => {
            return function(this: http2.ServerHttp2Stream) {
              const result = end.apply(this, arguments);
              // If none of `respond()`, `respondWithFD()`, or
              // `respondWithFile()` has been called, set the response code
              // label here with 200.
              addResponseCodeLabel();
              if (!isSpanEnded) {
                isSpanEnded = true;
                rootSpan.endSpan();
              }
              return result;
            };
          });
    });
  });
}

function patchHttp2(h2: NodeJS.Module, api: TraceAgent): void {
  // Patch client side.
  shimmer.wrap(
      h2, 'connect',
      (connect: typeof http2.connect): typeof http2.connect => function(
          this: NodeJS.Module, authority: string|URL) {
        const session: http2.ClientHttp2Session =
            connect.apply(this, arguments);
        patchClientHttp2Session(session, authority, api);
        return session;
      });

  // Patch server side.
  shimmer.wrap(
      h2, 'createServer',
      (createServer: typeof http2.createServer):
          typeof http2.createServer => function(this: NodeJS.Module) {
        const server: http2.Http2Server = createServer.apply(this, arguments);
        patchHttp2Server(server, api);
        return server;
      });
  shimmer.wrap(
      h2, 'createSecureServer',
      (createSecureServer: typeof http2.createSecureServer):
          typeof http2.createSecureServer => function(this: NodeJS.Module) {
        const server: http2.Http2SecureServer =
            createSecureServer.apply(this, arguments);
        patchHttp2Server(server, api);
        return server;
      });
}

function unpatchHttp2(h2: NodeJS.Module) {
  shimmer.unwrap(h2, 'connect');
  shimmer.unwrap(h2, 'createServer');
  shimmer.unwrap(h2, 'createSecureServer');
}

module.exports = [
  {
    file: 'http2',
    patch: patchHttp2,
    unpatch: unpatchHttp2,
  },
];
