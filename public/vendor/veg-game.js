(function(){
  var debugEl = document.getElementById('debugHud');
  var errEl = document.getElementById('err');
  function debug(msg){ if (debugEl) debugEl.textContent = String(msg || ''); }
  function showErr(msg){ if (errEl) { errEl.style.display = 'flex'; errEl.textContent = String(msg || 'error'); } debug('ERR: ' + msg); }
  try {
    var br = document.getElementById('btnRefresh');
    if (br) br.addEventListener('click', function(){ location.reload(); });
    if (!window.Phaser) { showErr('Phaser โหลดไม่ขึ้น'); return; }

    var W = 180, H = 320;
    var tile = 16;
    var viewCols = Math.floor(W / tile), viewRows = Math.floor(H / tile);
    var worldCols = viewCols * 3, worldRows = viewRows, worldW = worldCols * tile, worldH = worldRows * tile;
    var baseZoom = 1, userZoom = 1, currentCameraZoom = 1;

    function containerSize(){
      var el = document.getElementById('stage');
      var r = el.getBoundingClientRect();
      return { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
    }

    var game = new Phaser.Game({
      type: Phaser.CANVAS,
      parent: 'stage',
      backgroundColor: '#0b0f14',
      width: W,
      height: H,
      pixelArt: true,
      antialias: false,
      antialiasGL: false,
      roundPixels: true,
      input: { activePointers: 3, touch: { capture: true } },
      scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.CENTER_BOTH, parent: 'stage', width: W, height: H },
      scene: { preload: preload, create: create }
    });

    function updateDebug(cam){
      debug([
        'scrollX=' + (cam ? cam.scrollX.toFixed(2) : '-'),
        'scrollY=' + (cam ? cam.scrollY.toFixed(2) : '-')
      ].join('\n'));
    }

    function positionCamera(cam){
      currentCameraZoom = 1;
      cam.setZoom(currentCameraZoom);
      var totalZoom = (baseZoom || 1) * currentCameraZoom;
      var viewW = W / totalZoom;
      var viewH = H / totalZoom;
      cam.useBounds = false;
      var roomCenterX = worldW / 2;
      var roomCenterY = worldH / 2;
      // force true center mode at max zoom-out so room does not collapse to bottom-right
      if (currentCameraZoom <= 0.35) {
        cam.scrollX = -(viewW - worldW) / 2;
        cam.scrollY = -(viewH - worldH) / 2;
      } else {
        var visibleWorldCenterX = roomCenterX;
        if (viewW > worldW) visibleWorldCenterX = roomCenterX - ((viewW - worldW) / 2);
        cam.scrollX = visibleWorldCenterX - (viewW / 2);
        cam.scrollY = roomCenterY - (viewH / 2);
      }
      updateDebug(cam);
    }

    function applyZoom(){
      var s = containerSize();
      baseZoom = Math.max(s.w / W, s.h / H);
      var z = Math.max(0.05, Math.min(24, Math.round(baseZoom * 20) / 20));
      if (game.scale && game.scale.setParentSize) game.scale.setParentSize(s.w, s.h);
      game.scale.setZoom(z);
      var scene = game.scene && game.scene.scenes && game.scene.scenes[0];
      var cam = scene && scene.cameras && scene.cameras.main;
      if (cam) positionCamera(cam);
    }

    function preload(){
      debug('preload');
      var g = this.make.graphics({x:0,y:0,add:false});
      g.clear(); g.fillStyle(0x587a9b,1); g.fillRect(0,0,16,16); g.fillStyle(0x3f5e7d,1); g.fillRect(0,0,16,3); g.fillStyle(0x2f475f,1); g.fillRect(0,15,16,1); g.generateTexture('tile_wall',16,16);
      g.clear(); g.fillStyle(0x6f4a2d,1); g.fillRect(0,4,32,12); g.fillStyle(0x8a5a35,1); g.fillRect(0,0,32,6); g.fillStyle(0x3a2516,1); g.fillRect(0,15,32,1); g.generateTexture('counter',32,16);
      g.clear(); g.fillStyle(0x6b7a45,1); g.fillRect(0,2,32,12); g.fillStyle(0x4c5a31,1); g.fillRect(0,12,32,2); g.fillStyle(0x2a321b,1); g.fillRect(0,14,32,2); g.generateTexture('shelf',32,16);
      g.clear(); g.fillStyle(0x3a2516,1); g.fillRect(0,0,16,16); g.fillStyle(0x6f4a2d,1); g.fillRect(2,2,12,14); g.fillStyle(0x1a120b,1); g.fillRect(7,8,2,2); g.generateTexture('door',16,16);
      g.clear(); g.fillStyle(0x1b2a1a,1); g.fillRect(0,0,64,18); g.fillStyle(0x2f7d32,1); g.fillRect(1,1,62,16); g.fillStyle(0x124115,1); g.fillRect(2,2,60,14); g.generateTexture('sign',64,18);
      g.clear(); g.fillStyle(0x6d4c2f,1); g.fillRect(0,0,24,16); g.fillStyle(0x8b5e34,1); g.fillRect(1,1,22,14); g.fillStyle(0x4a2f1c,1); g.fillRect(0,3,24,2); g.fillRect(0,11,24,2); g.generateTexture('crate',24,16);
      g.clear(); g.fillStyle(0x8b6b3f,1); g.fillRect(0,4,22,12); g.fillStyle(0xb08955,1); g.fillRect(1,5,20,10); g.generateTexture('basket',22,16);
      g.clear(); g.fillStyle(0x2f8f3a,1); g.fillCircle(6,6,5); g.fillCircle(12,10,5); g.fillCircle(18,6,5); g.generateTexture('veg_leaf',24,16);
      g.clear(); g.fillStyle(0xe53935,1); g.fillCircle(7,8,4); g.fillCircle(13,6,4); g.fillCircle(18,9,4); g.generateTexture('veg_tomato',24,16);
      g.clear(); g.fillStyle(0x4caf50,1); g.fillRect(2,6,20,4); g.fillStyle(0x81c784,1); g.fillRect(4,4,16,8); g.generateTexture('veg_cucumber',24,16);
      g.clear(); g.fillStyle(0xffca28,1); g.fillCircle(6,8,4); g.fillCircle(12,7,4); g.fillCircle(18,8,4); g.generateTexture('veg_lemon',24,16);
      g.clear(); g.fillStyle(0x2e7d32,1); g.fillRect(8,2,8,10); g.fillStyle(0x6d4c41,1); g.fillRect(10,12,4,8); g.fillStyle(0x43a047,1); g.fillCircle(12,4,8); g.generateTexture('plant',24,24);
      g.clear(); g.fillStyle(0xf5f5dc,1); g.fillRect(0,0,18,10); g.fillStyle(0x6d4c41,1); g.fillRect(0,9,18,1); g.generateTexture('price_tag',18,10);
      g.clear(); g.fillStyle(0xb0bec5,1); g.fillRect(0,6,30,12); g.fillStyle(0x78909c,1); g.fillRect(2,8,26,8); g.fillStyle(0x37474f,1); g.fillRect(9,0,12,8); g.generateTexture('scale',30,18);
      g.clear(); g.fillStyle(0xffffff,1); g.fillRect(2,2,18,12); g.fillStyle(0xe0e0e0,1); g.fillRect(0,4,2,8); g.fillRect(20,4,2,8); g.generateTexture('bag',22,16);
      g.clear(); g.fillStyle(0x90a4ae,1); g.fillRect(0,0,32,18); g.fillStyle(0xb0bec5,1); g.fillRect(2,2,28,14); g.fillStyle(0xcfd8dc,1); g.fillRect(4,4,24,10); g.generateTexture('fridge',32,18);
      g.clear(); g.fillStyle(0xff7043,1); g.fillRect(8,2,4,14); g.fillStyle(0x66bb6a,1); g.fillRect(5,0,10,5); g.generateTexture('carrot',16,16);
    }

    function create(){
      debug('create');
      var c = this.sys.game.canvas;
      c.style.imageRendering = 'pixelated';
      c.style.imageRendering = 'crisp-edges';

      var cam = this.cameras.main;
      cam.roundPixels = true;

      var floor = this.add.graphics();
      floor.fillStyle(0xb07a4a,1); floor.fillRect(0,0,worldW,worldH);
      floor.fillStyle(0x8e5f39,1); for (var yy=0; yy<worldH; yy+=tile) floor.fillRect(0,yy,worldW,2);
      floor.fillStyle(0x935f35,1); for (var yy2=8; yy2<worldH; yy2+=tile) floor.fillRect(0,yy2,worldW,1);

      for (var x=0; x<worldCols; x++) this.add.image(x*tile, 0, 'tile_wall').setOrigin(0,0);
      for (var y=0; y<worldRows; y++) {
        this.add.image(0, y*tile, 'tile_wall').setOrigin(0,0);
        this.add.image((worldCols-1)*tile, y*tile, 'tile_wall').setOrigin(0,0);
      }

      var doorX = Math.floor(worldCols/2)*tile, doorY = (worldRows-1)*tile;
      this.add.image(doorX, doorY, 'door').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*2, tile*12, 'counter').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2), tile*12, 'counter').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*6, tile*6, 'shelf').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*4, tile*6, 'shelf').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2), tile*1, 'sign').setOrigin(0.5,0);
      this.add.text(Math.floor(worldW/2), tile*1+4, 'VEG SHOP', {fontFamily:'monospace', fontSize:'10px', color:'#d9fbe1'}).setOrigin(0.5,0);
      this.add.text(Math.floor(worldW/2), tile*3, 'ผักสดทุกวัน', {fontFamily:'monospace', fontSize:'8px', color:'#ffe9b3'}).setOrigin(0.5,0);

      // storefront decoration
      this.add.image(Math.floor(worldW/2)-tile*7, tile*10, 'crate').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*7+4, tile*10+1, 'veg_leaf').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*7+2, tile*11+2, 'price_tag').setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)-tile*7+5, tile*11+4, '20', {fontFamily:'monospace', fontSize:'6px', color:'#333'}).setOrigin(0,0);

      this.add.image(Math.floor(worldW/2)-tile*4, tile*10, 'crate').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*4+4, tile*10+1, 'veg_tomato').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*4+2, tile*11+2, 'price_tag').setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)-tile*4+5, tile*11+4, '35', {fontFamily:'monospace', fontSize:'6px', color:'#333'}).setOrigin(0,0);

      this.add.image(Math.floor(worldW/2)+tile*3, tile*10, 'crate').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*3+4, tile*10+1, 'veg_cucumber').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*3+2, tile*11+2, 'price_tag').setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)+tile*3+5, tile*11+4, '25', {fontFamily:'monospace', fontSize:'6px', color:'#333'}).setOrigin(0,0);

      this.add.image(Math.floor(worldW/2)+tile*6, tile*10, 'basket').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*6+1, tile*10, 'veg_lemon').setOrigin(0,0);

      // shelves with products
      this.add.image(Math.floor(worldW/2)-tile*6+4, tile*5, 'veg_leaf').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*6+18, tile*5, 'veg_tomato').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*4+4, tile*5, 'veg_cucumber').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*4+18, tile*5, 'veg_lemon').setOrigin(0,0);

      // plants / ambience
      this.add.image(tile*3, tile*12, 'plant').setOrigin(0,0);
      this.add.image(worldW - tile*5, tile*12, 'plant').setOrigin(0,0);
      this.add.text(tile*2, tile*15, 'ผักสด', {fontFamily:'monospace', fontSize:'8px', color:'#c8facc'}).setOrigin(0,0);
      this.add.text(worldW - tile*8, tile*15, 'ราคาดี', {fontFamily:'monospace', fontSize:'8px', color:'#fff1b8'}).setOrigin(0,0);

      // more shop details
      this.add.image(Math.floor(worldW/2)-tile*1, tile*11, 'scale').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*1, tile*11, 'bag').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*8, tile*5, 'fridge').setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)+tile*8+3, tile*5+5, 'เย็น', {fontFamily:'monospace', fontSize:'7px', color:'#244'}).setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*9, tile*5, 'fridge').setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)-tile*9+3, tile*5+5, 'สด', {fontFamily:'monospace', fontSize:'7px', color:'#244'}).setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)-tile*2, tile*13, 'carrot').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*2, tile*13, 'carrot').setOrigin(0,0);
      this.add.image(Math.floor(worldW/2)+tile*5, tile*13, 'bag').setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)-tile*3, tile*16, 'ผักกาด 20', {fontFamily:'monospace', fontSize:'7px', color:'#dff7d8'}).setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)+tile*2, tile*16, 'มะเขือ 35', {fontFamily:'monospace', fontSize:'7px', color:'#ffd6d6'}).setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)-tile*10, tile*3, 'เปิดทุกวัน', {fontFamily:'monospace', fontSize:'7px', color:'#d9fbe1'}).setOrigin(0,0);
      this.add.text(Math.floor(worldW/2)+tile*6, tile*3, 'ของสดเช้า', {fontFamily:'monospace', fontSize:'7px', color:'#fff1b8'}).setOrigin(0,0);

      var isPanning = false, startX = 0, startY = 0, startScrollX = 0, startScrollY = 0;
      this.input.on('pointerdown', function(pointer){
        var p1=this.input.pointer1, p2=this.input.pointer2;
        if (p1 && p2 && p1.isDown && p2.isDown) return;
        isPanning=true; startX=pointer.x; startY=pointer.y; startScrollX=cam.scrollX; startScrollY=cam.scrollY;
      }, this);
      this.input.on('pointerup', function(){ isPanning=false; });
      this.input.on('pointerout', function(){ isPanning=false; });
      this.input.on('pointermove', function(pointer){
        if (!isPanning) return;
        var p1=this.input.pointer1, p2=this.input.pointer2;
        if (p1 && p2 && p1.isDown && p2.isDown) return;
        var dx=pointer.x-startX, dy=pointer.y-startY;
        var panBoost=2.2;
        var denom=((game.scale.zoom||1)*(currentCameraZoom||1));
        cam.scrollX = startScrollX - ((dx*panBoost)/denom);
        cam.scrollY = startScrollY - ((dy*panBoost)/denom);
        updateDebug(cam);
      }, this);

      applyZoom();
    }

    window.addEventListener('resize', function(){ setTimeout(applyZoom, 50); });
    setTimeout(applyZoom, 50);
  } catch (err) {
    showErr(err && err.stack ? err.stack : err);
  }
})();
