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

const common = require('./common');

require('../../..').start({
  projectId: '0',
  ignoreUrls: ['/ignore'],
  samplingRate: 0,
});

import * as assert from 'assert';
// This is imported only for types. Generated .js file should NOT load 'http2'
// in this place. It is dynamically loaded later from each test suite below.
import * as http2 from 'http2';
import * as semver from 'semver';
import {TraceSpan} from '../../src/trace-span';
import {TraceLabels} from '../../src/trace-labels';

describe('test-trace-http2-server', () => {
  if (semver.satisfies(process.version, '<8')) {
    console.log(
        'Skipping test-trace-http2-server on Node.js version ' +
        process.version);
    return;
  }

  // FIXME: Uncomment before submit.
  // const http2 = require('http2');

  let server: http2.Http2Server;

  beforeEach(() => {
    server = http2.createServer();
  });

  afterEach(() => {
    common.cleanTraces();
    server.close();
  });

  it('should accurately measure get time', (done) => {
    server.on('stream', (stream) => {
      setTimeout(() => {
        stream.respond();
        stream.end(common.serverRes);
      }, common.serverWait);
    });
    server.listen(common.serverPort, () => {
      doRequest('GET', done, spanPredicate, '/');
    });
  });

  it('should have proper labels', (done) => {
    server.on('stream', (stream) => {
      stream.end(common.serverRes);
    });
    server.listen(common.serverPort, () => {
      const session = http2.connect(`http://localhost:${common.serverPort}`);
      const stream = session.request();
      stream.on('data', () => {}).on('end', () => {
        session.destroy();
        const labels = common.getMatchingSpan(spanPredicate).labels;
        assert.equal(labels[TraceLabels.HTTP_RESPONSE_CODE_LABEL_KEY], '200');
        assert.equal(labels[TraceLabels.HTTP_METHOD_LABEL_KEY], 'GET');
        assert.equal(
            labels[TraceLabels.HTTP_URL_LABEL_KEY],
            `http://localhost:${common.serverPort}/`);
        assert(labels[TraceLabels.HTTP_SOURCE_IP]);
        done();
      });
    });
  })
});

//
// Utility functions
//

function doRequest(
    method: string, done: MochaDone,
    tracePredicate: (span: TraceSpan) => boolean, path: string) {
  const start = Date.now();
  const session = http2.connect(`http://localhost:${common.serverPort}`);
  const stream = session.request({':path': path});
  let result = '';
  stream
      .on('data',
          (data) => {
            result += data;
          })
      .on('end', () => {
        session.destroy();
        assert.equal(result, common.serverRes);
        common.assertDurationCorrect(Date.now() - start, tracePredicate);
        done();
      });
  stream.end();
}

function spanPredicate(span: TraceSpan): boolean {
  return span.name === '/';
}
