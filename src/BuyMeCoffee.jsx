const embedDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        width: 250px;
        height: 60px;
        margin: 0;
        overflow: hidden;
        background: #FFDD00;
      }
    </style>
  </head>
  <body>
    <script
      type="text/javascript"
      src="https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js"
      data-name="bmc-button"
      data-slug="awmPhysics"
      data-color="#FFDD00"
      data-emoji=""
      data-font="Lato"
      data-text="Buy me a coffee"
      data-outline-color="#000000"
      data-font-color="#000000"
      data-coffee-color="#ffffff"
    ></script>
  </body>
</html>`;

export default function BuyMeCoffeeButton() {
  return (
    <span className="coffee-embed-frame">
      <iframe
        className="coffee-embed"
        title="Buy me a coffee"
        srcDoc={embedDocument}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      />
    </span>
  );
}