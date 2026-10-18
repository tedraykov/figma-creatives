// Throwaway helper: builds stand-in "H/Desktop" and "H/Mobile" template frames (auto-layout text stack,
// hug-width CTA pill, #Headline #Subheadline #cta #Note) so the campaign plugin can be tried in any file.
(async () => {
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  const page = figma.createPage();
  page.name = 'Test templates';
  await figma.setCurrentPageAsync(page);

  const solid = (r, g, b) => [{ type: 'SOLID', color: { r, g, b } }];
  const white = solid(1, 1, 1);

  function text(name, chars, size, style, mode) {
    const t = figma.createText();
    t.name = name;
    t.fontName = { family: 'Inter', style };
    t.fontSize = size;
    t.characters = chars;
    t.fills = white;
    t.textAutoResize = mode;
    return t;
  }

  function stack(name, dir, spacing) {
    const f = figma.createFrame();
    f.name = name;
    f.fills = [];
    f.layoutMode = dir;
    f.itemSpacing = spacing;
    f.primaryAxisSizingMode = 'AUTO';
    f.counterAxisSizingMode = 'FIXED';
    return f;
  }

  function template(name, w, h, x, headlineSize) {
    const frame = figma.createFrame();
    frame.name = name;
    frame.resize(w, h);
    frame.x = x;
    frame.fills = solid(0.69, 0.31, 0.2);
    page.appendChild(frame);

    const bg = figma.createRectangle();
    bg.name = '#Background';
    bg.resize(w, h);
    bg.fills = solid(0.69, 0.31, 0.2);
    frame.appendChild(bg);

    const col = stack('text', 'VERTICAL', 26);
    frame.appendChild(col);
    col.x = 48; col.y = 40;
    col.resize(w - 96, 100);

    const headline = text('#Headline', 'HEADLINE\nGOES HERE', headlineSize, 'Bold', 'HEIGHT');
    const sub = text('#Subheadline', 'A supporting line of copy', 28, 'Regular', 'HEIGHT');

    const button = stack('button', 'HORIZONTAL', 10);
    button.fills = white;
    button.cornerRadius = 50;
    button.paddingLeft = button.paddingRight = 30;
    button.paddingTop = button.paddingBottom = 20;
    button.primaryAxisAlignItems = 'CENTER';
    button.counterAxisAlignItems = 'CENTER';
    button.counterAxisSizingMode = 'AUTO';
    const cta = text('#cta', 'Shop now', 28, 'Bold', 'WIDTH_AND_HEIGHT');
    cta.fills = solid(0, 0, 0);
    button.appendChild(cta);

    const note = text('#Note', 'Terms and conditions apply', 18, 'Regular', 'HEIGHT');

    for (const n of [headline, sub, button, note]) col.appendChild(n);
    headline.layoutSizingHorizontal = 'FILL';
    sub.layoutSizingHorizontal = 'FILL';
    note.layoutSizingHorizontal = 'FILL';
    button.layoutSizingHorizontal = 'HUG';
    button.layoutSizingVertical = 'HUG';
    col.layoutSizingVertical = 'HUG';
  }

  template('H/Desktop', 1225, 720, 0, 96);
  template('H/Mobile', 540, 750, 1325, 56);
  figma.viewport.scrollAndZoomIntoView(page.children);
  figma.closePlugin('Created H/Desktop and H/Mobile on the "Test templates" page.');
})();
