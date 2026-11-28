import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { outputFiles } = await build({
  entryPoints: [new URL('../src/royalMail.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const {
  RoyalMailError, checkRoyalMailParcelService, createRoyalMailOrder, findRoyalMailOrder, fetchRoyalMailLabel, royalMailTrackingNumber, royalMailTrackingV2Number, fetchRoyalMailTracking,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

const key = 'fixture-private-click-and-drop-key';
const origin = 'https://api.parcel.royalmail.com/api/v1';
const pdf = '%PDF-1.7\nfixture\n%%EOF\n';
const input = {
  reference: 'WS-001-01',
  orderDate: '2026-11-26T13:15:00Z',
  recipient: {
    name: 'Sample Person',
    companyName: 'Sample Company',
    addressLine1: '1 Example Street',
    addressLine2: 'Suite 4',
    city: 'Norwich',
    postcode: 'nr21de',
  },
  parcel: { format: 'mediumParcel', weightInGrams: 7500 },
  serviceCode: 'TPS48',
  serviceRegisterCode: '01',
  shippingAccountName: 'Main shipping account',
  subtotalPence: 3500,
  shippingPence: 500,
  totalPence: 4700,
};
const providerOrder = {
  orderIdentifier: 892,
  orderReference: input.reference,
  // Tracking may be populated per parcel before a tracking number appears on the order.
  packages: [{ packageNumber: 1, trackingNumber: 'ab123456789gb' }],
};
const expected = {
  orderId: 892, reference: input.reference, trackingNumber: 'AB123456789GB', providerState: 'created',
};
const success = () => Response.json({ successCount: 1, errorsCount: 0, createdOrders: [providerOrder] });
const outcome = (code, uncertain, status) => error => {
  assert.ok(error instanceof RoyalMailError);
  assert.equal(error.code, code);
  assert.equal(error.uncertain, uncertain);
  if (status !== undefined) assert.equal(error.status, status);
  assert.doesNotMatch(error.message, /fixture-private|Sample Person|Example Street|other-order-identifier/);
  return true;
};

test('sends one GB parcel with the documented contract and returns only safe order data', async () => {
  let calls = 0;
  const result = await createRoyalMailOrder(key, input, async (url, init) => {
    calls += 1;
    assert.equal(url, origin + '/orders');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.get('Authorization'), 'Bearer ' + key);
    assert.equal(init.headers.get('content-type'), 'application/json');
    const data = JSON.parse(init.body);
    assert.deepEqual(data, { items: [{
      orderReference: 'WS-001-01',
      orderDate: '2026-11-26T13:15:00.000Z',
      isRecipientABusiness: true,
      recipient: { address: {
        fullName: 'Sample Person',
        companyName: 'Sample Company',
        addressLine1: '1 Example Street',
        addressLine2: 'Suite 4',
        city: 'Norwich',
        postcode: 'NR2 1DE',
        countryCode: 'GBR',
      } },
      packages: [{ weightInGrams: 7500, packageFormatIdentifier: 'mediumParcel' }],
      currencyCode: 'GBP',
      subtotal: 35,
      shippingCostCharged: 5,
      orderTax: 7,
      total: 47,
      postageDetails: { serviceCode: 'TPS48', serviceRegisterCode: '01', shippingAccountName: 'Main shipping account' },
      label: { includeLabelInResponse: true, includeReturnsLabel: false, includeCN: false },
    }] });
    return success();
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, expected);
});

test("sends the recipient's phone and email for delivery updates, only when valid", async () => {
  const sent = async (recipient) => {
    let body;
    await createRoyalMailOrder(key, { ...input, recipient: { ...input.recipient, ...recipient } }, async (url, init) => { body = JSON.parse(init.body); return success(); });
    const { address, ...contact } = body.items[0].recipient;
    return contact;
  };
  assert.deepEqual(await sent({ phoneNumber: '01603 (123) 456', emailAddress: ' orders@example.test ' }), { phoneNumber: '01603 123 456', emailAddress: 'orders@example.test' });
  assert.deepEqual(await sent({ phoneNumber: '12', emailAddress: 'not an email' }), {});
  assert.deepEqual(await sent({}), {});
});

test('recognises an inline OBA label without returning it in the order DTO', async () => {
  const label = Buffer.from(pdf).toString('base64');
  assert.deepEqual(await createRoyalMailOrder(key, input, async () => Response.json({
    successCount: 1, errorsCount: 0, createdOrders: [{ ...providerOrder, label }],
  })), { ...expected, providerState: 'labelled' });
  assert.deepEqual(await createRoyalMailOrder(key, input, async () => Response.json({
    successCount: 1, errorsCount: 0, createdOrders: [{ ...providerOrder, label: Buffer.from('%PDF-1.7\ntruncated').toString('base64') }],
  })), expected);
});

test('checks service, parcel, dates, totals and GB address before sending', async () => {
  const noNetwork = async () => { assert.fail('invalid order sent to Royal Mail'); };
  for (const patch of [
    { reference: '../other' }, { orderDate: '2026-11-26' }, { serviceCode: '..' },
    { orderDate: '2026-02-30T12:00:00Z' }, { orderDate: '2026-11-26T13:15:00' },
    { serviceRegisterCode: '00' }, { serviceRegisterCode: 'st' },
    { parcel: { format: 'letter', weightInGrams: 50 } }, { parcel: { ...input.parcel, weightInGrams: 30001 } },
    { totalPence: 3999 }, { recipient: { ...input.recipient, postcode: 'BT1 5GS' } },
    { recipient: { ...input.recipient, addressLine1: '' } },
  ]) {
    await assert.rejects(createRoyalMailOrder(key, { ...input, ...patch }, noNetwork), outcome('royal_mail_invalid_shipment', false));
  }
  await assert.rejects(createRoyalMailOrder('bad\nkey', input, noNetwork), outcome('royal_mail_configuration', false));
});

test('uncertain creates are never repeated or confirmed by malformed or mismatched results', async () => {
  const attempts = [
    [() => { throw new Error('secret and Sample Person'); }, 'royal_mail_unavailable'],
    [() => new Response('Sample Person', { status: 502 }), 'royal_mail_unavailable'],
    [() => new Response(null, { status: 302, headers: { Location: 'https://unexpected.invalid' } }), 'royal_mail_unavailable'],
    [() => new Response('Try again', { status: 429 }), 'royal_mail_rate_limited'],
    [() => new Response('{"42":', { headers: { 'content-type': 'application/json' } }), 'royal_mail_invalid_response'],
    [() => Response.json({ successCount: 0, errorsCount: 1, createdOrders: [] }), 'royal_mail_invalid_response'],
    [() => Response.json({ successCount: 1, errorsCount: 0, createdOrders: [
      { ...providerOrder, orderReference: 'other-order-identifier' },
    ] }), 'royal_mail_invalid_response'],
    [() => Response.json({ successCount: 1, errorsCount: 0, createdOrders: [
      { ...providerOrder, packages: [...providerOrder.packages, { packageNumber: 2, trackingNumber: 'ZZ123456789GB' }] },
    ] }), 'royal_mail_invalid_response'],
  ];
  for (const [reply, code] of attempts) {
    let calls = 0;
    await assert.rejects(createRoyalMailOrder(key, input, async () => { calls += 1; return reply(); }), outcome(code, true));
    assert.equal(calls, 1);
  }
});

test('reports definitive rejections without echoing the API body', async () => {
  await assert.rejects(createRoyalMailOrder(key, input, async () => new Response(key, { status: 401 })),
    outcome('royal_mail_auth', false, 401));
  await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json({
    successCount: 0, errorsCount: 1, createdOrders: [],
    failedOrders: [{ order: { orderReference: input.reference }, errors: [{ message: 'Example Street' }] }],
  })), outcome('royal_mail_rejected', false, 400));
});

test("keeps Royal Mail's own reason for a refusal, without the recipient's details", async () => {
  const reason = async (reply) => { try { await createRoyalMailOrder(key, input, async () => reply()); } catch (error) { return error; } };
  let error = await reason(() => Response.json({
    successCount: 0, errorsCount: 1, createdOrders: [],
    failedOrders: [{ order: { orderReference: input.reference }, errors: [{ errorCode: 61, errorMessage: 'Service code NDB is not valid for 1 Example Street, NR2 1DE', fields: [{ fieldName: 'postageDetails.serviceCode', value: 'NDB' }] }] }],
  }));
  outcome('royal_mail_rejected', false, 400)(error);
  assert.match(error.message, /Royal Mail said: Service code NDB is not valid for …, … \(code 61, field postageDetails.serviceCode\)/);
  assert.doesNotMatch(error.message, /NR2 1DE|NR21DE/);
  error = await reason(() => Response.json({ errors: [{ errorCode: 2, errorMessage: 'Recipient phone number is required', fields: [{ fieldName: 'recipient.phoneNumber' }] }] }, { status: 400 }));
  outcome('royal_mail_rejected', false, 400)(error);
  assert.match(error.message, /Recipient phone number is required \(code 2, field recipient.phoneNumber\)/);
  // Other reply shapes seen from Click & Drop: a plain message, or a validation map of fields to messages.
  error = await reason(() => Response.json({ code: 'BadRequest', message: 'Service not available on 1 Example Street' }, { status: 400 }));
  assert.match(error.message, /Royal Mail said: Service not available on … \(code BadRequest\)/);
  error = await reason(() => Response.json({ title: 'One or more validation errors occurred.', errors: { 'items[0].postageDetails.serviceRegisterCode': ['Invalid service register code'] } }, { status: 400 }));
  assert.match(error.message, /One or more validation errors occurred\.; Invalid service register code \(field items\[0\]\.postageDetails\.serviceRegisterCode\)/);
  error = await reason(() => Response.json([{ errorCode: 5, errorMessage: 'Weight too high for Sample Company' }], { status: 400 }));
  assert.match(error.message, /Weight too high for … \(code 5\)/);
  error = await reason(() => new Response('not json', { status: 400 }));
  outcome('royal_mail_invalid_response', true)(error);
});

test("carrier diagnostics retain retry guards and never quote unrecognised error text or field values", async () => {
  const privateValues = "private@example.test, 01603 123456, MY-KEY and an unknown customer's address";
  const reason = { errorCode: 15, errorMessage: "Recipient phone number is required", fields: [
    {fieldName:"recipient.phoneNumber", value:privateValues}, {fieldName:"private@example.test.recipient.phoneNumber"},
  ] };
  for (const status of [400, 422]) {
    const reply = body => createRoyalMailOrder(key, input, async () => Response.json(body, {status}));
    await assert.rejects(reply({errors:[reason, {errorMessage:privateValues}]}), error => {
      assert.equal(error.uncertain, false);
      assert.match(error.message, /phone number is required \(code 15, field recipient.phoneNumber\)/i);
      assert.doesNotMatch(error.message, /private@|01603|MY-KEY|unknown customer/);
      return true;
    });
    for (const extra of [{orderReference:"WS-OTHER"}, {label:privateValues}, {orderIdentifier:8}]) {
      await assert.rejects(reply({errors:[{...reason, ...extra}]}), outcome("royal_mail_invalid_response", true));
    }
    await assert.rejects(reply({errors:[reason,{message:"Order was already booked"}]}), error => {
      assert.equal(error.uncertain, true);
      return true;
    });
  }
});

test("additional carrier validation formats preserve useful wording without quoting private values", async () => {
  const rejection = body => createRoyalMailOrder(key, input, async () => Response.json(body, {status:422}));
  for (const [textField, pathField] of [["detail", "propertyName"], ["title", "fieldName"], ["description", "field"]]) {
    await assert.rejects(rejection([{[textField]:"Weight too high for some unrelated private customer", code:5, [pathField]:"packages[0].weightInGrams"}]), error => {
      assert.equal(error.uncertain, false);
      assert.match(error.message, /Weight too high for … \(code 5, field packages\[0\]\.weightInGrams\)/);
      assert.doesNotMatch(error.message, /private customer/);
      return true;
    });
  }
  await assert.rejects(rejection({errors: [{errors: { "recipient.emailAddress": ["Email address is required", "other@example.test is the new contact"] }}],
    code:"secret-client-value", detail:"1 eXaMpLe StReEt", fieldName:"private.name"}), error => {
    assert.equal(error.uncertain, false);
    assert.match(error.message, /Email address is required \(field recipient.emailAddress\)/);
    assert.doesNotMatch(error.message, /@|secret-client-value|example street|private.name/i);
    return true;
  });
});

test("nested, batch and validation-map errors cannot hide duplicate, conflicting, or foreign booking evidence", async () => {
  const message = {errorCode:3, errorMessage:"Invalid postcode"};
  const envelope = error => ({successCount:0, errorsCount:1, failedOrders:[{order:{orderReference:input.reference},errors:[error]}]});
  const unsafe = [
    [message, {title:"201 Created"}],
    {title:"Request acknowledged"},
    {code:"OK", description:"Request received"},
    {errors:[message, {description:"Created the order"}]},
    {title:"One or more validation errors occurred.", errors:{orderReference:["Must be unique."]}},
    {errors:[message, {detail:"Order WS-OTHER already received"}]},
    {title:"Validation", errors:{postcode:[{message:"Invalid postcode",orderIdentifier:123}]}},
    [message, {errors:[{message:"bad input",success:true}]}],
    {...envelope(message), orderReference:"WS-OTHER"},
    {...envelope(message), trackingNumber:"AB123456789GB"},
    envelope({errors:[{message:"Order reference already used"}]}),
    envelope({errors:{orderReference:["Duplicate order reference"]}}),
    {errors:new Array(13).fill(message)},
  ];
  for (const status of [400, 422]) {
    for (const body of unsafe) {
      await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json(body, {status})), error => {
        assert.equal(error.uncertain,true);
        assert.doesNotMatch(error.message,/WS-OTHER|AB123456789GB/);
        return true;
      });
    }
  }
});

test('only a confirmed missing or exact unique lookup can be used for reconciliation', async () => {
  const reply = data => async (url, init) => {
    assert.equal(url, origin + '/orders/%22WS-001-01%22');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return Response.json(data);
  };
  const shippedOn = '2026-11-26T16:00:00Z';
  assert.deepEqual(await findRoyalMailOrder(key, input.reference, reply([{ ...providerOrder, shippedOn }])),
    { ...expected, providerState: 'dispatched' });
  assert.equal(await findRoyalMailOrder(key, input.reference, reply([])), null);
  assert.equal(await findRoyalMailOrder(key, input.reference, async () => new Response(null, { status: 404 })), null);
  assert.deepEqual(await findRoyalMailOrder(key, input.reference, reply([{ ...providerOrder, shippedOn: '2026-02-30T12:00:00Z' }])), expected);
  for (const data of [
    null, [providerOrder, providerOrder], [{ ...providerOrder, orderReference: 'other-order-identifier' }],
    [{ ...providerOrder, trackingNumber: 'ZZ123456789GB' }],
  ]) {
    await assert.rejects(findRoyalMailOrder(key, input.reference, reply(data)), outcome('royal_mail_invalid_response', false));
  }
  assert.equal(royalMailTrackingNumber('AB123456789GB'), 'AB123456789GB');
  assert.equal(royalMailTrackingNumber('ur041761424qi'), 'UR041761424QI');
  assert.equal(royalMailTrackingNumber('AB123456789GB_CON'), null);
  assert.equal(royalMailTrackingNumber('https://example.com'), null);
});

test('recognises Parcelforce public references without sending them to Tracking V2', async () => {
  const references = ['123456789', 'pF123456789', 'P123456789012', 'PF123456789012', '1234567890123456', 'PF0123456789012345678'];
  const credentials = { clientId: 'test-id', clientSecret: 'test-secret', acceptTerms: true };
  for (const raw of references) {
    assert.equal(royalMailTrackingNumber(raw), raw.toUpperCase());
    assert.equal(royalMailTrackingV2Number(raw), null);
    const response = [{ ...providerOrder, packages: [{ trackingNumber: raw }] }];
    const order = await findRoyalMailOrder(key, input.reference, () => Response.json(response));
    assert.equal(order.trackingNumber, raw.toUpperCase());
    await assert.rejects(fetchRoyalMailTracking(credentials, [raw], () => assert.fail('public-only reference sent to V2')),
      outcome('royal_mail_invalid_shipment', false));
  }
  for (const bad of ['notfound0/123', 'NOTFOUNDX', '1234567890', '123456789012345', '1234567890_CON', 'PF12345?6789', 'ORDER READY 2', 'PF1234567ß']) {
    assert.equal(royalMailTrackingNumber(bad), null, bad);
  }
  const ambiguous = [{ ...providerOrder, trackingNumber: '123456789' }];
  await assert.rejects(findRoyalMailOrder(key, input.reference, () => Response.json(ambiguous)), outcome('royal_mail_invalid_response', false));
});

test('retrieves a bounded, recognisable PDF by ID without sending another shipment', async () => {
  const bytes = await fetchRoyalMailLabel(key, 892, async (url, init) => {
    assert.equal(url, origin + '/orders/892/label?documentType=postageLabel&includeReturnsLabel=false&includeCN=false');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('accept'), 'application/pdf');
    assert.equal(init.headers.get('authorization'), 'Bearer ' + key);
    return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
  });
  assert.equal(new TextDecoder().decode(bytes), pdf);
  await assert.rejects(fetchRoyalMailLabel(key, 892, async () => new Response(null, { status: 403 })),
    outcome('royal_mail_denied', false, 403));
  await assert.rejects(fetchRoyalMailLabel(key, 892, async () => new Response('not a PDF', {
    headers: { 'content-type': 'application/pdf' },
  })), outcome('royal_mail_invalid_response', false));
  await assert.rejects(fetchRoyalMailLabel(key, 892, async () => new Response('%PDF-1.7\ntruncated', {
    headers: { 'content-type': 'application/pdf' },
  })), outcome('royal_mail_invalid_response', false));
  for (const status of [400, 404, 422]) {
    await assert.rejects(fetchRoyalMailLabel(key, 892, async () => new Response('Example Street', { status })),
      outcome('royal_mail_label_unavailable', false, status));
  }
  await assert.rejects(fetchRoyalMailLabel(key, 892, async () => new Response('%PDF-1.7', {
    headers: { 'content-type': 'application/pdf', 'content-length': String(4 * 1024 * 1024 + 1) },
  })), outcome('royal_mail_invalid_response', false));
});

test('interprets an exact Tracking V2 not-found envelope without hiding a mismatched or gateway error', async () => {
  const credentials = { clientId: 'fixture-tracking-id', clientSecret: 'fixture-tracking-secret', acceptTerms: true };
  const number = 'UR041761424QI';
  const missing = { mailPieceId: number, status: '404' };
  assert.deepEqual(await fetchRoyalMailTracking(credentials, [number], async () => Response.json({
    httpCode: '404', httpMessage: 'Not Found', mailPieces: [missing],
  }, { status: 404 })), [
    { trackingNumber: number, status: 'not-found', statusCategory: null, lastEventCode: null, lastEventName: null, lastEventAt: null },
  ]);
  for (const mailPieces of [[], [{ ...missing, mailPieceId: 'ZZ123456789GB' }], [{ ...missing, status: '200' }]]) {
    await assert.rejects(fetchRoyalMailTracking(credentials, [number], async () => Response.json({
      httpCode: '404', httpMessage: 'Not Found', mailPieces,
    }, { status: 404 })), outcome('royal_mail_invalid_response', false));
  }
});

test('limits streamed provider responses without content length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(768 * 1024));
      controller.enqueue(new Uint8Array(768 * 1024));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(createRoyalMailOrder(key, input, async () => new Response(stream, {
    headers: { 'content-type': 'application/json' },
  })), outcome('royal_mail_invalid_response', true));
  assert.equal(cancelled, true);
});

test('reads Tracking V2 summaries with separate approved credentials and no proof or private data', async () => {
  const credentials = { clientId: 'fixture-tracking-id', clientSecret: 'fixture-tracking-secret', acceptTerms: true };
  const number = 'AB123456789GB';
  const twoDimensional = '090367574000000FE1E1B';
  assert.equal(royalMailTrackingNumber(twoDimensional), twoDimensional);
  const summaries = await fetchRoyalMailTracking(credentials, [number, twoDimensional], async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, 'https://api.royalmail.net/mailpieces/v2/summary');
    assert.equal(target.searchParams.get('mailPieceId'), [number, twoDimensional].join(','));
    assert.equal(init.headers.get('x-ibm-client-id'), credentials.clientId);
    assert.equal(init.headers.get('x-ibm-client-secret'), credentials.clientSecret);
    assert.equal(init.headers.get('x-accept-rmg-terms'), 'yes');
    assert.equal(init.headers.get('authorization'), null);
    assert.equal(init.method, 'GET');
    return Response.json({ mailPieces: [
      { mailPieceId: twoDimensional, status: '404', error: { errorDescription: 'Private response' } },
      { mailPieceId: number, status: '200', summary: {
        statusCategory: 'DELIVERED', lastEventCode: 'EVNDL', lastEventName: 'Delivered',
        lastEventDateTime: '2026-11-26T16:20:00+01:00', summaryLine: 'Private address',
      } },
    ] });
  });
  assert.deepEqual(summaries, [
    { trackingNumber: number, status: 'available', statusCategory: 'DELIVERED', lastEventCode: 'EVNDL',
      lastEventName: 'Delivered', lastEventAt: '2026-11-26T15:20:00.000Z' },
    { trackingNumber: twoDimensional, status: 'not-found', statusCategory: null,
      lastEventCode: null, lastEventName: null, lastEventAt: null },
  ]);
  await assert.rejects(fetchRoyalMailTracking({ ...credentials, acceptTerms: false }, [number],
    async () => assert.fail('Tracking must be approved')), outcome('royal_mail_configuration', false));
  await assert.rejects(fetchRoyalMailTracking(credentials, [number], async () => Response.json({
    mailPieces: [{ mailPieceId: 'ZZ123456789GB', status: '200', summary: {} }],
  })), outcome('royal_mail_invalid_response', false));
});

test('booking refusals identify carrier fields and codes without exposing order values', async () => {
  const failed = {
    successCount: 0, errorsCount: 1, createdOrders: [],
    failedOrders: [{order: {orderReference: input.reference}, errors: [{
      errorCode: 4321, errorMessage: 'Sample Person / Example Street',
      fields: [{fieldName: 'items[0].postageDetails.serviceCode', value: key},
        {fieldName: 'Recipient.Address.Postcode', value: 'PRIVATE POSTCODE'}],
    }]}],
  };
  for (const status of [200, 400, 422]) {
    await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json(failed, {status})), error => {
      assert.equal(error.code, 'royal_mail_rejected');
      assert.equal(error.uncertain, false);
      assert.match(error.message, /configured service/);
      assert.match(error.message, /delivery postcode/);
      assert.match(error.message, /4321/);
      assert.doesNotMatch(error.message, /PRIVATE|fixture-private|Example Street|Sample Person/);
      return true;
    });
  }
  await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json({
    message: 'Invalid shipping account name: fixture-private', details: 'Example Street',
  }, {status:400})), error => {
    assert.match(error.message, /shipping account name in Royal Mail settings/);
    assert.doesNotMatch(error.message, /fixture-private|Example Street/);
    return true;
  });
});

test('only an unambiguous order-specific lookup miss permits a first booking', async () => {
  const reference = input.reference;
  const lookup = (body, status) => findRoyalMailOrder(key, reference, () => Response.json(body, { status }));
  for (const status of [400, 422]) {
    for (const body of [
      [{code: 'OrderNotFound', message: 'Order not found'}],
      {errors: [{message: 'No orders found for "' + reference + '"'}]},
      {errors: [{message: "Order with reference '" + reference + "' could not be found."}], status},
      {message: 'Order with reference "' + reference + '" was not found'},
      {message: 'Order "' + reference + '" not found'}, {message: 'No order with reference "' + reference + '" was found'},
      {message: 'Order with reference "' + reference + '" does not exist'},
      {channelOrderReference: null, accountOrderNumber: 0, code: null, message: 'Order not found'},
      [{accountOrderNumber: null, channelOrderReference: reference, code: 'NotFound', message: 'Not found.'}],
      {code: 'OrderReferenceNotFound'}, {orderReference: reference, code: 'NotFound'},
    ]) assert.equal(await lookup(body, status), null);

    for (const body of [
      [{code: 'NotFound'}, {message: 'Order not found'}], [{code: 'InvalidOrderIdentifier'}, {code: 'NotFound'}],
      {code: 'NotFound', orderReference: 'OTHER'}, {code: 'NotFound', message: 'Shipping account not found'},
      {code: 'NotFound', accountOrderNumber: 123}, {code: 'NotFound', errors: [{code: 'NotFound'}]},
      {message: 'Order "OTHER" not found'}, {message: 'No order with reference "OTHER" was found'},
      {message: 'Shipping account not found'}, {message: 'No order identifier supplied'},
      {code: 'OrderNotFound', detail: 'Permission denied'}, {code: 'Forbidden', message: 'Order not found'},
      {message: 'Order not found', orderReference: 'OTHER'}, {channelOrderReference: 'OTHER', code: 'OrderNotFound'},
      {message: 'No orders found for "OTHER"'}, {message: 'Order reference "' + reference.toLowerCase() + '" not found'},
      {message: 'Order not found', accountOrderNumber: 1024}, {message: 'Order not found', orderIdentifier: 1024},
      {title: 'Access denied', errors: [{message: 'Order not found'}]}, {orderReference: 'OTHER', errors: [{code: 'OrderNotFound'}]},
      {orders: [providerOrder], errors: [{message: 'Order not found'}]}, {errors: [{message: 'Order not found'}], status: 200},
      [{message: 'Order not found'}, {message: 'Rate limited'}], [{message: 'Order not found'}, null],
      Array(13).fill({message: 'Order not found'}), {errors: []}, {}, null,
    ]) {
      let calls = 0;
      await assert.rejects(findRoyalMailOrder(key, reference, () => {
        calls++;
        return Response.json(body, { status });
      }), outcome('royal_mail_rejected', false, status));
      assert.equal(calls, 1, 'conflicting or incomplete evidence cannot start the order-list fallback');
    }
  }
});

test('lookup refusals report recognised reasons without copying carrier text or credentials', async () => {
  const lookup = body => findRoyalMailOrder(key, input.reference, () => Response.json(body, {status: 400}));
  const mixed = [{code: 'InvalidOrderIdentifier', message: 'Access denied'}];
  let calls = 0;
  await assert.rejects(findRoyalMailOrder(key, input.reference, () => {
    calls++;
    return Response.json(mixed, {status: 400});
  }), outcome('royal_mail_rejected', false, 400));
  assert.equal(calls, 1, 'a contradictory selector error cannot start an alternative lookup');
  for (const body of [
    [{message: 'Bad value at 24 Example Street NR2 3HX'}], {code: 'PrivateSecret', message: 'Customer Alice Smith'},
    {message: 'Permission denied', errors: [{message: 'Private Street'}]}, {title: key},
  ]) await assert.rejects(lookup(body), error => {
    assert.doesNotMatch(error.message, /Example Street|NR2|Customer Alice|Private|fixture-private/);
    assert.match(error.message, /order-reference lookup/);
    return true;
  });
  for (const body of ['not found', '{', 'x'.repeat(17000)]) await assert.rejects(findRoyalMailOrder(key, input.reference,
    () => new Response(body, {status: 400})), outcome('royal_mail_rejected', false, 400));
});

test('a reference lookup refusal is distinct from a purchase refusal and duplicate evidence requires recovery', async () => {
  await assert.rejects(findRoyalMailOrder(key, input.reference, async () => Response.json({}, {status:400})), error => {
    assert.match(error.message, /order-reference lookup/);
    return true;
  });
  await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json(
    {message: 'An order with this order reference already exists.'}, {status:422},
  )), error => {
    assert.equal(error.uncertain, true);
    assert.match(error.message, /already have this booking/);
    return true;
  });
  await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json(
    {successCount:1,createdOrders:[providerOrder]}, {status:400},
  )), outcome('royal_mail_invalid_response', true));
});

test('only an identified carrier error or a single correlated refusal unlocks a purchase retry', async () => {
  const failure = {order:{orderReference: input.reference}, errors:[{message:"Invalid postcode"}]};
  for (const status of [400, 422]) {
    for (const body of ["", "carrier disconnected", "x".repeat(33000), "[]", "{}", JSON.stringify({ failedOrders: [failure] }),
      JSON.stringify({message: "Bad parcel", errorsCount: 1, failedOrders: [failure, failure]}),
      JSON.stringify({successCount: 0, errorsCount: 1, failedOrders: [{...failure, order: {orderReference: "OTHER"}}]}),
      JSON.stringify({successCount: 0, errorsCount: 1, failedOrders: [{...failure, errors: [{}]}]}),
      JSON.stringify({message: "Parcels processed", orderIdentifier: 32}),
      JSON.stringify({message: "Invalid postcode", order: {orderReference: "OTHER"}}),
      JSON.stringify({fields:[{fieldName:""}]}),
    ]) {
      await assert.rejects(createRoyalMailOrder(key, input, async () => new Response(body, {status})), outcome("royal_mail_invalid_response", true));
    }
    for (const body of [{code:"18"}, {fields:[{fieldName:"recipient.address.postcode"}]}, {message:"Invalid parcel format"}]) {
      await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json(body, {status})), outcome("royal_mail_rejected", false, status));
    }
  }
  for (const error of [
    {message:"OrderReference already exists."},
    {message:"Order reference is already in use."},
    {message:"Order has already been created."},
    {message:"Order was successfully created."},
    {code:"DuplicateOrderReference"},
    {message:"Must be unique.", fields:[{fieldName:"orderReference"}]},
  ]) {
    for (const status of [200, 400, 422]) {
      const envelope = {successCount:0, errorsCount:1, failedOrders:[{...failure, errors:[error]}]};
      await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json(envelope, {status})), e => {
        assert.equal(e.uncertain, true); assert.match(e.message, /already have this booking/); return true;
      });
    }
  }
  await assert.rejects(createRoyalMailOrder(key, input, async () => Response.json({
    successCount:1, errorsCount:0, createdOrders:[providerOrder], failedOrders:[failure],
  })), outcome("royal_mail_invalid_response", true));
});

test('service discovery scopes the existing service to the weighed parcel and distinguishes unknowns', async () => {
  const group = (shippingAccountName, serviceCode = "TPS48") => ({ shippingAccountName, carrierGuid: crypto.randomUUID(),
    services: [{ serviceCode, serviceName: "Test service", carrierServiceGuid: crypto.randomUUID() }] });
  const shippingAccountName = "Roastery & Co", configured = { serviceCode: "TPS48", shippingAccountName };
  function lookup(settings, groups, accounts = []) {
    const calls = [];
    const check = checkRoyalMailParcelService(key, settings, "NR2 1DE", 8500, async (url, init) => {
      assert.equal(init.method, "GET"); assert.equal(init.body, undefined); assert.equal(init.redirect, "manual");
      assert.equal(init.headers.get("Authorization"), "Bearer " + key);
      const { pathname, searchParams } = new URL(url);
      calls.push(pathname);
      if (pathname.endsWith("/carriers")) return Response.json(accounts);
      assert.equal(pathname, "/api/v1/services");
      assert.equal(searchParams.get("destinationCountryCode"), "GBR");
      assert.equal(searchParams.get("destinationPostcode"), "NR2 1DE");
      assert.equal(searchParams.get("packagingFormat"), "Parcel");
      assert.equal(searchParams.get("packageWeight"), "8500");
      assert.equal(searchParams.get("shippingAccountName"), settings.shippingAccountName || null);
      return groups instanceof Response ? groups : Response.json(groups);
    });
    return { calls, check };
  }
  const single = lookup(configured, [group(shippingAccountName)]);
  assert.equal((await single.check).available, true);
  assert.deepEqual(single.calls, ["/api/v1/services"]);
  const multiple = lookup({ serviceCode: "TPS48" }, [group(shippingAccountName)], [{ shippingAccountName }, { shippingAccountName: "Other account" }]);
  assert.match((await multiple.check).message, /multiple shipping accounts/i);
  assert.deepEqual(multiple.calls, ["/api/v1/services", "/api/v1/carriers"]);
  assert.equal((await lookup({ serviceCode: "TPS48" }, [group(shippingAccountName)], [{ shippingAccountName }]).check).available, true);
  assert.equal((await lookup(configured, []).check).available, false);
  assert.equal((await lookup(configured, [group(shippingAccountName, "OTHER")]).check).available, false);
  const register = await lookup({ ...configured, serviceRegisterCode: "04" }, [group(shippingAccountName)]).check;
  assert.equal(register.available, null); assert.match(register.message, /register 04/);
  assert.equal((await lookup(configured, [group("Wrong account")]).check).available, null);
  assert.equal((await lookup(configured, [{ shippingAccountName, services: [{}] }]).check).available, null);
  for (const status of [400, 401, 403, 429, 500]) {
    const uncertain = await lookup(configured, new Response("private customer and carrier detail", { status })).check;
    assert.equal(uncertain.available, null); assert.doesNotMatch(uncertain.message, /private customer/);
  }
});
