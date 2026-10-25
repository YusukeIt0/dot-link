import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePhoto, selectPhoto, MAX_PHOTO_BYTES } from '../src/photo-attachments.ts';
import { photoFixture } from './photo-fixture.ts';

function browser(t: any, options: { width?: number; height?: number; decodeError?: boolean; tooLarge?: boolean } = {}) {
 const oldImage = globalThis.Image, oldDocument = globalThis.document;
 const images: any[] = [], sizes: number[][] = [];
 class TestImage {
  naturalWidth = options.width ?? 4000; naturalHeight = options.height ?? 3000;
  onload?: () => void; onerror?: () => void;
  source = '';
  constructor() { images.push(this); }
  set src(value: string) { this.source = value; if (value) queueMicrotask(() => options.decodeError ? this.onerror?.() : this.onload?.()); }
  get src() { return this.source; }
 }
 const canvas = {width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},drawImage(){}}),toDataURL:()=>{
  sizes.push([canvas.width,canvas.height]);
  return 'data:image/jpeg;base64,' + (options.tooLarge ? 'A'.repeat(MAX_PHOTO_BYTES * 2) : photoFixture().data);
 }};
 globalThis.Image = TestImage as any;
 globalThis.document = {createElement:()=>canvas} as any;
 t.after(()=>{globalThis.Image=oldImage;globalThis.document=oldDocument;});
 return {images,canvas,sizes};
}
const asset = {mimeType:'image/jpeg',base64:photoFixture().data,name:'private-name.jpg',path:'/private/camera/private-name.jpg',size:1000};
test('both SDK photo sources use the same bounded pixel re-encoding without forwarding asset metadata', async t=>{
 const b=browser(t);const calls:string[]=[];
 const bridge={captureImageFromCamera:async()=>{calls.push('camera');return asset;},pickImageFromAlbum:async()=>{calls.push('album');return asset;}};
 for(const source of ['camera','album'] as const) {
  const photo=await selectPhoto(source,bridge);
  assert.deepEqual(Object.keys(photo!).sort(),['data','mimeType']);
  assert.deepEqual(photo,photoFixture());
 }
 assert.deepEqual(calls,['camera','album']);assert.deepEqual(b.sizes,[[2048,1536],[2048,1536]]);
 assert.equal(b.canvas.width,0);assert.ok(b.images.every(image=>image.src===''&&image.onload===null));
 assert.equal(await selectPhoto('album',{...bridge,pickImageFromAlbum:async()=>null}),null);
});
test('image preparation rejects unsupported payloads before decoding', async t=>{
 const b=browser(t);
 for(const value of [{...asset,mimeType:'image/svg+xml'},{...asset,base64:''},{...asset,base64:'data:image/jpeg;base64,AAAA'}]) await assert.rejects(preparePhoto(value));
 assert.equal(b.images.length,0);
});
test('image decoding and size failures release canvas and image references', async t=>{
 const b=browser(t,{tooLarge:true});await assert.rejects(preparePhoto(asset),/size limit/);
 assert.equal(b.sizes.length,9);assert.deepEqual(b.sizes.at(-1),[1024,768]);
 assert.equal(b.canvas.width,0);assert.equal(b.images[0].src,'');
});
test('invalid image dimensions are rejected before allocating a canvas',async t=>{
 const b=browser(t,{width:10000,height:10000});await assert.rejects(preparePhoto(asset),/dimensions/);
 assert.equal(b.sizes.length,0);assert.equal(b.images[0].src,'');
});
