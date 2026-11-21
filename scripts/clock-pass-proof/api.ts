import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const {redactSensitiveText,redactToolPayloadText,redactLogRecordForTransport}=await import(process.cwd()+'/src/logging/redact.ts');
const prose = [
'At 17:34 the review found one thing for the UX pass: the screen shows two buttons.',
'11:1x Builder done, first pass: the batch is complete.',
'250:- Second pass: retry is fine.',
'At 7:04:09 the review finished, first pass: the screen is ready.',
'At 17:xx the review finished, first pass: the screen is ready.',
'At 17:34 the review finished.\n250:- Second pass: retry is fine.',
];
const actual=prose.map(input=>redactSensitiveText(input,{mode:'tools'}));
if(process.env.CLOCK_SIDE==='candidate')for(let i=0;i<prose.length;i++)assert.equal(actual[i],prose[i]);
else for(let i=0;i<3;i++)assert.notEqual(actual[i],prose[i]);
const starts = ['17:34 pass: ','user:bot pass: ','At 17:34 user=bot first pass: ','At 17:34 user:bot first pass: ','host17:34 first pass: ','17:34suffix first pass: ','user=bot at 17:34 first pass: ','smtp.pass: ','db-pass: ','pass = ','pass: "'];
for(const start of starts) {
 const end=start.endsWith('"')?'"':'';
 assert.equal(redactSensitiveText(start+'opaque-pass-secret-1234567890'+end,{mode:'tools'}),start+'opaque…7890'+end);
}
const fixture=JSON.parse(readFileSync(process.cwd()+'/src/logging/redact-byte-identity-fixture.json','utf8'));
const restore=(text:string)=>text.replace(/@@S/g,':');
for(let i=0;i<fixture.samples.length;i++) {
 const sample=restore(fixture.samples[i]); const expected=fixture.outputs[i].map(restore);
 assert.equal(redactSensitiveText(sample,{mode:'tools'}),expected[0]);
 assert.equal(redactToolPayloadText(sample),expected[1]);
 assert.equal(JSON.stringify(redactLogRecordForTransport({message:sample,level:'info'})),expected[2]);
}
console.log(JSON.stringify({prose:prose.length,recordControls:starts.length,existingByteIdentitySamples:fixture.samples.length,exit:0}));

writeFileSync(process.env.CLOCK_OUTPUT!,JSON.stringify({side:process.env.CLOCK_SIDE,prose,actual,recordControls:starts.length,byteSamples:fixture.samples.length}));
