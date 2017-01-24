'use strict';

var test = require('tape');
var webdriver = require('selenium-webdriver');
var chrome = require('selenium-webdriver/chrome');
var firefox = require('selenium-webdriver/firefox');

var seleniumHelpers = require('webrtc-utilities').seleniumLib;

function buildDriver(browser, version, platform) {
  // Firefox options.
  var profile = new firefox.Profile();
  profile.setPreference('media.navigator.streams.fake', true);
  profile.setPreference('media.navigator.permission.disabled', true);
  profile.setPreference('xpinstall.signatures.required', false);

  var firefoxOptions = new firefox.Options()
      .setProfile(profile);

  // Chrome options.
  var chromeOptions = new chrome.Options()
      .addArguments('allow-file-access-from-files')
      .addArguments('use-fake-device-for-media-stream')
      .addArguments('use-fake-ui-for-media-stream')
      .addArguments('disable-translate')
      .addArguments('no-process-singleton-dialog')
      .addArguments('mute-audio'); // might be harmful for this test

  var driver;
  if (process.env.SAUCE_USERNAME) {
    // using travis' sauceconnect plugin.
    var username = process.env.SAUCE_USERNAME;
    var key = process.env.SAUCE_ACCESS_KEY;
    var driver = new webdriver.Builder()
      .usingServer('http://' + username + ':' + key + '@localhost:4445/wd/hub')
      //.usingServer('http://' + username + ':' + key + '@ondemand.saucelabs.com/wd/hub')
      //.usingServer('http://localhost:4444/wd/hub')
      .withCapabilities({
        'tunnel-identifier': process.env.TRAVIS_JOB_NUMBER
      })
      .setFirefoxOptions(firefoxOptions)
      .setChromeOptions(chromeOptions)
      .forBrowser(browser, version, platform)
      .build();
  } else {
    driver= new webdriver.Builder()
        .forBrowser(browser, version, platform)
        .setFirefoxOptions(firefoxOptions)
        .setChromeOptions(chromeOptions);
    if (browser === 'firefox') {
      driver.getCapabilities().set('marionette', true);
    }
    driver = driver.build();
  }

  // Set global executeAsyncScript() timeout (default is 0) to allow async
  // callbacks to be caught in tests.
  // TODO: GUM takes an awful long time on saucelabs, ~25 seconds
  driver.manage().timeouts().setScriptTimeout(600 * 1000);

  return driver;
}

function basicTest() {
  var callback = arguments[arguments.length - 1];
  
  var remoteVideo = document.createElement('video');
  remoteVideo.id = 'remoteVideo';
  remoteVideo.autoplay = true;
  document.body.appendChild(remoteVideo);

  var pc1 = new RTCPeerConnection(null);
  var pc2 = new RTCPeerConnection(null);

  pc2.ontrack = function(e) {
    remoteVideo.srcObject = e.streams[0];
  };

  var addCandidate = function(pc, event) {
    if (event.candidate) {
      var cand = new RTCIceCandidate(event.candidate);
      pc.addIceCandidate(cand)
      .catch(function(err) {
        console.log(err);
      });
    }
  };
  pc1.onicecandidate = function(event) {
    addCandidate(pc2, event);
  };
  pc2.onicecandidate = function(event) {
    addCandidate(pc1, event);
  };

  var constraints = {audio: true};
  navigator.mediaDevices.getUserMedia(constraints)
  .then(function(stream) {
    var origStream = stream;
    pc1.addStream(stream); // TODO: use addTrack?
    pc1.createOffer().then(function(offer) {
      return pc1.setLocalDescription(offer);
    }).then(function() {
      return pc2.setRemoteDescription(pc1.localDescription);
    }).then(function() {
      return pc2.createAnswer();
    }).then(function(answer) {
      return pc2.setLocalDescription(answer);
    }).then(function() {
      return pc1.setRemoteDescription(pc2.localDescription);
    }).then(function() {
      window.setTimeout(function() {
        navigator.mediaDevices.getUserMedia({video: true})
        .then(function(stream) {
          if (adapter.browserDetails.browser === 'chrome') {
            pc1.getLocalStreams()[0].addTrack(stream.getTracks()[0]);
          } else if (adapter.browserDetails.browser === 'firefox') {
            // not yet -- https://bugzilla.mozilla.org/show_bug.cgi?id=1245983
            //origStream.addTrack(stream.getTracks()[0]); // Firefox
            //pc1.addTrack(stream.getTracks()[0], origStream); // Firefox
            // adding a different stream as a workaround
            pc1.addTrack(stream.getTracks()[0], stream);
          }
          pc1.createOffer().then(function(offer) {
            var desc = offer;
            //desc.sdp = desc.sdp.replace(stream.id, origStream.id);
            return pc1.setLocalDescription(desc);
          }).then(function() {
            // present a single remote stream to the remote side. Could also be
            // done before SLD but that seems a slightly bigger risk.
            var desc = pc1.localDescription;
            desc.sdp = desc.sdp.replace(stream.id, origStream.id);
            return pc2.setRemoteDescription(desc);
          }).then(function() {
            return pc2.createAnswer();
          }).then(function(answer) {
            return pc2.setLocalDescription(answer);
          }).then(function() {
            return pc1.setRemoteDescription(pc2.localDescription);
          }).then(function() {
            callback();
          });
        });
      }, 3000);
    }).catch(function(err) {
      callback(err);
    });
  })
  .catch(function(err) {
    callback(err);
  });
}

function getVideo() {
    var callback = arguments[arguments.length - 1];
    var remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo.videoWidth < 10 && remoteVideo.videoHeight < 10) {
        return callback([0, 0, 0]);
    }
    var canvas = document.createElement('canvas');
    canvas.width = remoteVideo.videoWidth;
    canvas.height = remoteVideo.videoHeight;

    var context = canvas.getContext('2d');
    context.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
    var data = context.getImageData(0, 0, canvas.width/10, canvas.height/10).data;
    // taken from testrtc
    var accumulatedLuma = 0;
    for (var i = 0; i < data.length; i += 4) {
        accumulatedLuma += 0.21 * data[i] + 0.72 * data[i+1] + 0.07 * data[i+2];
    }
    callback([remoteVideo.videoWidth, remoteVideo.videoHeight, accumulatedLuma]);
}

function mangle(sdp) {
    var mediaSections = sdp.split('\r\nm=');
    sdp = mediaSections.shift().trim();
    mediaSections = mediaSections.map(function(mediaSection) {
        mediaSection = 'm=' + mediaSection.trim() + '\r\n';
        var lines = mediaSection.split('\r\n');

        // translate chrome msid to firefox
        // a=ssrc:12345 msid:stream track
        // -> a=msid:stream track
        // but not if a=msid is already there
        var chromelines = {};
        lines.forEach(function(line) {
            // only take the first ssrc because fid and simulcast
            // TODO: write test with simulcast.
            if (!chromelines.ssrcmsid && line.indexOf('a=ssrc:') === 0 && line.indexOf(' msid:') !== -1) {
                chromelines.ssrcmsid = line;
            }
            if (line.indexOf('a=msid:') === 0) {
                chromelines.msid = line;
            }
        });
        if (chromelines.ssrcmsid && !chromelines.msid) {
            var parts = chromelines.ssrcmsid.split(' ');
            parts.shift();
            mediaSection += 'a=' + parts.join(' ') + '\r\n';
        }

        // translate firefox msid to chrome msid
        // a=ssrc:12345 cname:something
        // a=msid:stream track
        // -> a=ssrc:12345 msid:stream track
        var fflines = {}
        lines.forEach(function(line) {
            if (line.indexOf('a=msid:') === 0) {
                fflines.msid = line;
            }
            if (line.indexOf('a=ssrc:') === 0 && line.indexOf(' cname:') !== -1) {
                fflines.cname = line;
            }
        });
        if (fflines.msid && fflines.cname) {
            mediaSection += fflines.cname.split(' ', 1)[0] + ' ' + fflines.msid.substr(2) + '\r\n';
        }
        return mediaSection.trim();
    });
    sdp += '\r\n' + mediaSections.join('\r\n');
    //console.log(sdp);
    return sdp.trim() + '\r\n';
}

function interop(t, browserA, browserB) {
  var driverA = buildDriver(browserA);
  var driverB = buildDriver(browserB);


  driverA.get('https://fippo.github.io/adapter/testpage.html')
  .then(function() {
    return driverB.get('https://fippo.github.io/adapter/testpage.html')
  }).then(function() {
    return driverA.executeAsyncScript(function() {
      var callback = arguments[arguments.length - 1];
      
      var remoteVideo = document.createElement('video');
      remoteVideo.autoplay = true;
      remoteVideo.id = 'remoteVideo';
      document.body.appendChild(remoteVideo);

      window.pc1 = new RTCPeerConnection(null);

      pc1.onicecandidate = function(event) {
        console.log(event.candidate);
        if (!event.candidate) {
          callback(pc1.localDescription.sdp);
        }
      };

      var constraints = {audio: true};
      navigator.mediaDevices.getUserMedia(constraints)
      .then(function(stream) {
        var origStream = stream;
        pc1.addStream(stream); // TODO: use addTrack?
        pc1.createOffer().then(function(offer) {
          return pc1.setLocalDescription(offer);
        })
      });
    })
    .then(function(offer) {
      t.pass('got offer');
      offer = mangle(offer);
      return driverB.executeAsyncScript(function(offer) {
        var callback = arguments[arguments.length - 1];
        
        var remoteVideo = document.createElement('video');
        remoteVideo.id = 'remoteVideo';
        remoteVideo.autoplay = true;
        document.body.appendChild(remoteVideo);

        window.pc1 = new RTCPeerConnection(null);

        pc1.ontrack = function(e) {
          remoteVideo.srcObject = e.streams[0];
        };

        pc1.onicecandidate = function(event) {
          console.log(event.candidate);
          if (!event.candidate) {
            callback(pc1.localDescription.sdp);
          }
        };

        pc1.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer }))
        .then(function() {
          return pc1.createAnswer();
        })
        .then(function(answer) {
          return pc1.setLocalDescription(answer);
        });
      }, offer);
    })
    .then(function(answer) {
      t.pass('got answer');
      answer = mangle(answer);
      return driverA.executeAsyncScript(function(answer) {
        var callback = arguments[arguments.length - 1];
        
        pc1.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer}))
        .then(function() {
          callback();
        });
      }, answer);
    });
  })
  .then(function() {
    return driverA.sleep(3000);
  })
  .then(function() {
    return driverA.executeAsyncScript(function() {
      var callback = arguments[arguments.length - 1];

      var constraints = {video: true};
      navigator.mediaDevices.getUserMedia(constraints)
      .then(function(stream) {
        var origStream = stream;
        if (adapter.browserDetails.browser === 'chrome') {
          pc1.getLocalStreams()[0].addTrack(stream.getTracks()[0]);
        } else if (adapter.browserDetails.browser === 'firefox') {
          // not yet -- https://bugzilla.mozilla.org/show_bug.cgi?id=1245983
          //origStream.addTrack(stream.getTracks()[0]); // Firefox
          //pc1.addTrack(stream.getTracks()[0], origStream); // Firefox
          // adding a different stream as a workaround
          pc1.addTrack(stream.getTracks()[0], stream);
        }
        pc1.createOffer().then(function(offer) {
          return pc1.setLocalDescription(offer);
        })
        .then(function() {
          var desc = pc1.localDescription;
          desc.sdp = desc.sdp.replace(pc1.getLocalStreams()[0].id, origStream.id);
          callback(desc.sdp);
        });
      });
    });
  })
  .then(function(offer) {
    t.pass('reoffer');
    offer = mangle(offer);
    return driverB.executeAsyncScript(function(offer) {
      var callback = arguments[arguments.length - 1];
      
      pc1.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer }))
      .then(function() {
        return pc1.createAnswer();
      })
      .then(function(answer) {
        return pc1.setLocalDescription(answer);
      })
      .then(function() {
        callback(pc1.localDescription.sdp);
      });
    }, offer);
  })
  .then(function(answer) {
    t.pass('reanswer');
    answer = mangle(answer);
    return driverA.executeAsyncScript(function(answer) {
      var callback = arguments[arguments.length - 1];
      
      pc1.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer}))
      .then(function() {
        callback();
      });
    }, answer);
  })
  .then(function() {
    return driverA.sleep(3000);
  })
  .then(function() {
    return driverB.executeAsyncScript(getVideo)
  })
  .then(function(data) {
    var width = data[0];
    var height = data[1];
    var luma = data[2];
    t.ok(width > 0, 'width > 0');
    t.ok(height > 0, 'height > 0');
    t.ok(luma > 0, 'accumulated luma is > 0');
  })
  .then(function() {
    return driverA.close()
    .then(function() {
      return driverA.quit()
    });
  })
  .then(function() {
    return driverB.close()
    .then(function() {
      return driverB.quit()
    });
  })
  .then(function() {
    t.end();
  });
}

test('basic', function (t) {
    var driver = buildDriver(process.env.BROWSER || 'chrome', process.env.BVER || '')
    driver.get('https://fippo.github.io/adapter/testpage.html')
    .then(function() {
        return driver.executeScript('return navigator.userAgent;');
    })
    .then(function(ua) {
        console.log(ua);
    })
    .then(function() {
        return driver.executeAsyncScript(basicTest)
    })
    .then(function(err) {
        t.ok(err === null, 'renegotiation works');
        return driver.sleep(3000);
    })
    .then(function() {
        return driver.executeAsyncScript(getVideo)
    })
    .then(function(data) {
        var width = data[0];
        var height = data[1];
        var luma = data[2];
        t.ok(width > 0, 'width > 0');
        t.ok(height > 0, 'height > 0');
        t.ok(luma > 0, 'accumulated luma is > 0');
    })
    .then(function() {
      driver.close()
      .then(function() {
        return driver.quit();
      })
      .then(function() {
        t.end();
      });
    })
    .catch(function(err) {
      t.fail(err);
    });
});

// interop doesn't work @ sauce labs
/*
test('interop chrome chrome', function (t) {
  interop(t, 'chrome', 'chrome');
});

test('interop firefox firefox', function (t) {
  interop(t, 'firefox', 'firefox');
});

test('interop chrome firefox', function (t) {
  interop(t, 'chrome', 'firefox');
});

test('interop firefox chrome', function (t) {
  interop(t, 'firefox', 'firefox');
});
*/
