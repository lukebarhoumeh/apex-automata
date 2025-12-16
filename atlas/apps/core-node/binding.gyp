{
  "targets": [
    {
      "target_name": "trading_engine",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags": [ "-std=c++20", "-O3", "-march=native", "-mtune=native", "-flto" ],
      "cflags_cc": [ "-std=c++20", "-O3", "-march=native", "-mtune=native", "-flto" ],
      "sources": [ 
        "src/native/trading_engine_wrapper.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../trading-engine-cpp/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++20", "/O2", "/GL", "/arch:AVX2" ]
            }
          }
        }],
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "OTHER_CFLAGS": [ "-O3", "-march=native", "-flto" ]
          }
        }]
      ]
    }
  ]
}
