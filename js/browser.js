/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Broad Institute
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

var igv = (function (igv) {

    igv.Browser = function (options, trackContainer) {

        igv.browser = this;   // Make globally visible (for use in html markup).

        this.config = options;

        this.div = $('<div id="igvRootDiv" class="igv-root-div">')[0];

        initialize.call(this, options);

        $("input[id='trackHeightInput']").val(this.trackHeight);

        this.trackContainerDiv = trackContainer;

        addTrackContainerHandlers(trackContainer);

        this.trackViews = [];

        this.trackLabelsVisible = true;

        this.featureDB = {};   // Hash of name -> feature, used for search function.

        this.constants = {
            dragThreshold: 3,
            defaultColor: "rgb(0,0,150)",
            doubleClickDelay: options.doubleClickDelay || 500
        };

        // Map of event name -> [ handlerFn, ... ]
        this.eventHandlers = {};

        window.onresize = igv.throttle(function () {
            igv.browser.resize();
        }, 10);

    };

    function initialize(options) {
        var genomeId;

        this.flanking = options.flanking;
        this.type = options.type || "IGV";
        this.crossDomainProxy = options.crossDomainProxy;
        this.formats = options.formats;
        this.trackDefaults = options.trackDefaults;

        if (options.search) {
            this.searchConfig = {
                type: "json",
                url: options.search.url,
                coords: options.search.coords === undefined ? 1 : options.search.coords,
                chromosomeField: options.search.chromosomeField || "chromosome",
                startField: options.search.startField || "start",
                endField: options.search.endField || "end",
                resultsField: options.search.resultsField
            }
        }
        else {

            if (options.reference && options.reference.id) {
                genomeId = options.reference.id;
            }
            else if (options.genome) {
                genomeId = options.genome;
            }
            else {
                genomeId = "hg19";
            }

            this.searchConfig = {
                // Legacy support -- deprecated
                type: "plain",
                url: "//www.broadinstitute.org/webservices/igv/locus?genome=" + genomeId + "&name=$FEATURE$",
                coords: 0,
                chromosomeField: "chromosome",
                startField: "start",
                endField: "end"

            }
        }
    }

    igv.Browser.prototype.getFormat = function (name) {
        if (this.formats === undefined) return undefined;
        return this.formats[name];
    };

    igv.Browser.prototype.loadTracksWithConfigList = function (configList) {

        var self = this;

        configList.forEach(function (config) {
            self.loadTrack(config);
        });

        // Really we should just resize the new trackViews, but currently there is no way to get a handle on those
        this.trackViews.forEach(function (trackView) {
            trackView.resize();
        })

    };

    igv.Browser.prototype.loadTrack = function (config) {

        var self = this,
            settings,
            property,
            newTrack,
            featureSource,
            nm;

        inferTypes(config);

        // Set defaults if specified
        if (this.trackDefaults && config.type) {
            settings = this.trackDefaults[config.type];
            if (settings) {
                for (property in settings) {
                    if (settings.hasOwnProperty(property) && config[property] === undefined) {
                        config[property] = settings[property];
                    }
                }
            }
        }

        switch (config.type) {
            case "gwas":
                newTrack = new igv.GWASTrack(config);
                break;
            case "annotation":
            case "genes":
            case "FusionJuncSpan":
                newTrack = new igv.FeatureTrack(config);
                break;
            case "variant":
                newTrack = new igv.VariantTrack(config);
                break;

            case "alignment":

                newTrack = new igv.BAMTrack(config, featureSource);
                break;

            case "data":  // deprecated
            case "wig":
                newTrack = new igv.WIGTrack(config);
                break;
            case "sequence":
                newTrack = new igv.SequenceTrack(config);
                break;
            case "eqtl":
                newTrack = new igv.EqtlTrack(config);
                break;
            case "seg":
                newTrack = new igv.SegTrack(config);
                break;
            case "aneu":
                newTrack = new igv.AneuTrack(config);
                break;
            default:

                //alert("Unknown file type: " + config.url);
                igv.presentAlert("Unknown file type: " + (config.type || ''));

                return null;
        }

        // Set order field of track here.  Otherwise track order might get shuffled during asynchronous load
        if (undefined === newTrack.order) {
            newTrack.order = this.trackViews.length;
        }


        // If defined, attempt to load the file header before adding the track.  This will catch some errors early
        if (typeof newTrack.getFileHeader === "function") {
            newTrack.getFileHeader().then(function (header) {
                self.addTrack(newTrack);
            }).catch(function (error) {
                //alert(error);
                igv.presentAlert(error);
            });
        }
        else {
            self.addTrack(newTrack);
        }

    };


    /**
     * Add a new track.  Each track is associated with the following DOM elements
     *
     *      leftHandGutter  - div on the left for track controls and legend
     *      contentDiv  - a div element wrapping all the track content.  Height can be > viewportDiv height
     *      viewportDiv - a div element through which the track is viewed.  This might have a vertical scrollbar
     *      canvas     - canvas element upon which the track is drawn.  Child of contentDiv
     *
     * The width of all elements should be equal.  Height of the viewportDiv is controlled by the user, but never
     * greater than the contentDiv height.   Height of contentDiv and canvas are equal, and governed by the data
     * loaded.
     *
     * @param track
     */
    igv.Browser.prototype.addTrack = function (track) {

        var trackView = new igv.TrackView(track, this);

        if (typeof igv.popover !== "undefined") {
            igv.popover.hide();
        }

        // Register view with track.  This backpointer is unfortunate, but is needed to support "resize" events.
        track.trackView = trackView;


        this.trackViews.push(trackView);

        this.reorderTracks();

        trackView.resize();
    };

    igv.Browser.prototype.reorderTracks = function () {

        var myself = this;

        this.trackViews.sort(function (a, b) {
            var aOrder = a.track.order || 0;
            var bOrder = b.track.order || 0;
            return aOrder - bOrder;
        });

        // Reattach the divs to the dom in the correct order
        $(this.trackContainerDiv).children("igv-track-div").detach();

        this.trackViews.forEach(function (trackView, index, trackViews) {

            myself.trackContainerDiv.appendChild(trackView.trackDiv);

        });

    };

    igv.Browser.prototype.removeTrack = function (track) {

        // Find track panel
        var trackPanelRemoved;
        for (var i = 0; i < this.trackViews.length; i++) {
            if (track === this.trackViews[i].track) {
                trackPanelRemoved = this.trackViews[i];
                break;
            }
        }

        if (trackPanelRemoved) {
            this.trackViews.splice(i, 1);
            this.trackContainerDiv.removeChild(trackPanelRemoved.trackDiv);
            this.fireEvent('trackremoved', [trackPanelRemoved.track]);
        }

    };

    igv.Browser.prototype.reduceTrackOrder = function (trackView) {

        var indices = [],
            raisable,
            raiseableOrder;

        if (1 === this.trackViews.length) {
            return;
        }

        this.trackViews.forEach(function (tv, i, tvs) {

            indices.push({trackView: tv, index: i});

            if (trackView === tv) {
                raisable = indices[i];
            }

        });

        if (0 === raisable.index) {
            return;
        }

        raiseableOrder = raisable.trackView.track.order;
        raisable.trackView.track.order = indices[raisable.index - 1].trackView.track.order;
        indices[raisable.index - 1].trackView.track.order = raiseableOrder;

        this.reorderTracks();

    };

    igv.Browser.prototype.increaseTrackOrder = function (trackView) {

        var j,
            indices = [],
            raisable,
            raiseableOrder;

        if (1 === this.trackViews.length) {
            return;
        }

        this.trackViews.forEach(function (tv, i, tvs) {

            indices.push({trackView: tv, index: i});

            if (trackView === tv) {
                raisable = indices[i];
            }

        });

        if ((this.trackViews.length - 1) === raisable.index) {
            return;
        }

        raiseableOrder = raisable.trackView.track.order;
        raisable.trackView.track.order = indices[1 + raisable.index].trackView.track.order;
        indices[1 + raisable.index].trackView.track.order = raiseableOrder;

        this.reorderTracks();

    };

    igv.Browser.prototype.setTrackHeight = function (newHeight) {

        this.trackHeight = newHeight;

        this.trackViews.forEach(function (panel) {
            panel.setTrackHeight(newHeight);
        });

    };

    igv.Browser.prototype.resize = function () {
        if (this.ideoPanel) this.ideoPanel.resize();
        if (this.karyoPanel) this.karyoPanel.resize();
        this.trackViews.forEach(function (panel) {
            panel.resize();
        })
    };

    igv.Browser.prototype.repaint = function () {

        if (this.ideoPanel) {
            this.ideoPanel.repaint();
        }

        if (this.karyoPanel) {
            this.karyoPanel.repaint();
        }
        this.trackViews.forEach(function (trackView) {
            trackView.repaint();
        });

    };

    igv.Browser.prototype.update = function () {

        this.updateLocusSearch(this.referenceFrame);

        if (this.ideoPanel) {
            this.ideoPanel.repaint();
        }

        if (this.karyoPanel) {
            this.karyoPanel.repaint();
        }

        this.trackViews.forEach(function (trackPanel) {
            trackPanel.update();
        });

    };

    igv.Browser.prototype.loadInProgress = function () {
        var i;
        for (i = 0; i < this.trackViews.length; i++) {
            if (this.trackViews[i].loading) {
                return true;
            }
        }
        return false;
    };

    igv.Browser.prototype.updateLocusSearch = function (referenceFrame) {

        var chr,
            ss,
            ee,
            str,
            end,
            chromosome;


        if (this.$searchInput) {

            chr = referenceFrame.chr;
            ss = igv.numberFormatter(Math.floor(referenceFrame.start + 1));

            end = referenceFrame.start + this.trackViewportWidthBP();
            if (this.genome) {
                chromosome = this.genome.getChromosome(chr);
                if (chromosome) end = Math.min(end, chromosome.bpLength);
            }

            ee = igv.numberFormatter(Math.floor(end));

            str = chr + ":" + ss + "-" + ee;
            this.$searchInput.val(str);

            this.windowSizePanel.update(Math.floor(end - referenceFrame.start));
        }

        this.fireEvent('locuschange', [referenceFrame, str]);
    };

    /**
     * Return the visible width of a track.  All tracks should have the same width.
     */
    igv.Browser.prototype.trackViewportWidth = function () {

        var width;

        if (this.trackViews && this.trackViews.length > 0) {
            width = this.trackViews[0].viewportDiv.clientWidth;
        }
        else {
            width = this.trackContainerDiv.clientWidth - 100;   // Should never get here
        }

        return width;

    };

    igv.Browser.prototype.pixelPerBasepairThreshold = function () {
        return 14.0;
    };

    igv.Browser.prototype.trackViewportWidthBP = function () {
        return this.referenceFrame.bpPerPixel * this.trackViewportWidth();
    };

    igv.Browser.prototype.removeAllTracks = function () {
        var tracks = this.trackViews;

        for (var i = 0; i < tracks.length; i++) {
            var track = this.trackViews[i].track;
            this.removeTrack(track);
        }
    };

    igv.Browser.prototype.setGotoCallback = function (gotocallback) {
        this.gotocallback = gotocallback;
    };

    igv.Browser.prototype.goto = function (chr, start, end) {

        if (typeof this.gotocallback != "undefined") {
            //console.log("Got chr="+chr+", start="+start+", end="+end+", also using callback "+this.gotocallback);
            this.gotocallback(chr, start, end);
        }

        var w,
            chromosome,
            viewportWidth = this.trackViewportWidth();

        if (igv.popover) {
            igv.popover.hide();
        }

        // Translate chr to official name
        if (this.genome) {
            chr = this.genome.getChromosomeName(chr);
        }

        this.referenceFrame.chr = chr;

        // If end is undefined,  interpret start as the new center, otherwise compute scale.
        if (!end) {
            w = Math.round(viewportWidth * this.referenceFrame.bpPerPixel / 2);
            start = Math.max(0, start - w);
        }
        else {
            this.referenceFrame.bpPerPixel = (end - start) / (viewportWidth);
        }

        if (this.genome) {
            chromosome = this.genome.getChromosome(this.referenceFrame.chr);
            if (!chromosome) {
                if (console && console.log) console.log("Could not find chromsome " + this.referenceFrame.chr);
            }
            else {
                if (!chromosome.bpLength) chromosome.bpLength = 1;

                var maxBpPerPixel = chromosome.bpLength / viewportWidth;
                if (this.referenceFrame.bpPerPixel > maxBpPerPixel) this.referenceFrame.bpPerPixel = maxBpPerPixel;

                if (!end) {
                    end = start + viewportWidth * this.referenceFrame.bpPerPixel;
                }

                if (chromosome && end > chromosome.bpLength) {
                    start -= (end - chromosome.bpLength);
                }
            }
        }

        this.referenceFrame.start = start;

        this.update();

    };

// Zoom in by a factor of 2, keeping the same center location
    igv.Browser.prototype.zoomIn = function () {

        if (this.loadInProgress()) {
            // ignore
            return;
        }

        var newScale,
            center,
            viewportWidth;

        viewportWidth = this.trackViewportWidth();

        newScale = Math.max(1.0 / this.pixelPerBasepairThreshold(), this.referenceFrame.bpPerPixel / 2);
        if (newScale === this.referenceFrame.bpPerPixel) {
            //console.log("zoom in bail bpp " + newScale + " width " + (viewportWidth/14.0));
            return;
        }

        center = this.referenceFrame.start + this.referenceFrame.bpPerPixel * viewportWidth / 2;
        this.referenceFrame.start = center - newScale * viewportWidth / 2;
        this.referenceFrame.bpPerPixel = newScale;
        this.update();
    };

// Zoom out by a factor of 2, keeping the same center location if possible
    igv.Browser.prototype.zoomOut = function () {

        if (this.loadInProgress()) {
            // ignore
            return;
        }

        var newScale, maxScale, center, chrLength, widthBP, viewportWidth;
        viewportWidth = this.trackViewportWidth();

        newScale = this.referenceFrame.bpPerPixel * 2;
        chrLength = 250000000;
        if (this.genome) {
            var chromosome = this.genome.getChromosome(this.referenceFrame.chr);
            if (chromosome) {
                chrLength = chromosome.bpLength;
            }
        }
        maxScale = chrLength / viewportWidth;
        if (newScale > maxScale) newScale = maxScale;

        center = this.referenceFrame.start + this.referenceFrame.bpPerPixel * viewportWidth / 2;
        widthBP = newScale * viewportWidth;

        this.referenceFrame.start = Math.round(center - widthBP / 2);

        if (this.referenceFrame.start < 0) this.referenceFrame.start = 0;
        else if (this.referenceFrame.start > chrLength - widthBP) this.referenceFrame.start = chrLength - widthBP;

        this.referenceFrame.bpPerPixel = newScale;
        this.update();
    };


    /**
     *
     * @param feature
     * @param callback - function to call
     */
    igv.Browser.prototype.search = function (feature, callback) {

        // See if we're ready to respond to a search, if not just queue it up and return
        if (igv.browser === undefined || igv.browser.genome === undefined) {
            igv.browser.initialLocus = feature;
            if (callback) callback();
            return;
        }


        var type,
            chr,
            posTokens,
            start,
            end,
            searchConfig,
            tokens,
            url,
            chromosome,
            result;

        if (feature.includes(":") && feature.includes("-") || this.genome.getChromosome(feature)) {

            type = "locus";
            tokens = feature.split(":");
            chr = this.genome.getChromosomeName(tokens[0]);

            if (tokens.length == 1) {
                chromosome = this.genome.getChromosome(feature);
                start = 0;
                end = chromosome.bpLength;
            }
            else {
                chromosome = this.genome.getChromosome(chr);
                if (!chromosome) {
                    igv.presentAlert("Unknown chromosome: " + chr);
                    this.updateLocusSearch(this.referenceFrame);
                } else {
                    posTokens = tokens[1].split("-");
                    start = Math.max(0, parseInt(posTokens[0].replace(/,/g, "")) - 1);
                    end = parseInt(posTokens[1].replace(/,/g, ""));
                    if (end < 0) {
                        // This can happen from integer overflow
                        if (chromosome) end = chromosome.bpLength;
                    }
                    else {
                        end = Math.min(end, chromosome.bpLength);
                    }


                    if (isNaN(start) || isNaN(end) || (start > end)) {
                        igv.presentAlert("Unrecognized feature or locus: " + feature);
                        this.updateLocusSearch(this.referenceFrame);
                    } else {
                        this.goto(chr, start, end);
                        fireOnsearch.call(igv.browser, feature, type);
                    }
                }
            }
            if (callback) callback();

        }
        else {

            // Try local feature cache first
            result = this.featureDB[feature.toUpperCase()];
            if (result) {
                handleSearchResult(result.name, result.chr, result.start, result.end, "");
            }

            else if (this.searchConfig) {
                url = this.searchConfig.url.replace("$FEATURE$", feature);
                searchConfig = this.searchConfig;

                if (url.indexOf("$GENOME$") > -1) {
                    var genomeId = this.genome.id ? this.genome.id : "hg19";
                    url.replace("$GENOME$", genomeId);
                }

                // var loader = new igv.DataLoader(url);
                // if (range)  loader.range = range;
                // loader.loadBinaryString(callback);

                igvxhr.loadString(url).then(function (data) {

                    var results = ("plain" === searchConfig.type) ? parseSearchResults(data) : JSON.parse(data);

                    if (searchConfig.resultsField) {
                        results = results[searchConfig.resultsField];
                    }

                    if (results.length == 0) {
                        //alert('No feature found with name "' + feature + '"');
                        igv.presentAlert('No feature found with name "' + feature + '"');
                    }
                    else if (results.length == 1) {

                        // Just take the first result for now
                        // TODO - merge results, or ask user to choose

                        r = results[0];
                        chr = r[searchConfig.chromosomeField];
                        start = r[searchConfig.startField] - searchConfig.coords;
                        end = r[searchConfig.endField];
                        type = r["featureType"] || r["type"];
                        handleSearchResult(feature, chr, start, end, type);
                    }
                    else {
                        presentSearchResults(results, searchConfig, feature);
                    }

                    if (callback) callback();
                });
            }
        }


    };

    function presentSearchResults(loci, config, feature) {

        igv.browser.$searchResultsTable.empty();
        igv.browser.$searchResults.show();

        loci.forEach(function (locus) {

            var row = $('<tr class="igvNavigationSearchResultsTableRow">');
            row.text(locus.locusString);

            row.click(function () {

                igv.browser.$searchResults.hide();

                handleSearchResult(
                    feature,
                    locus[config.chromosomeField],
                    locus[config.startField] - config.coords,
                    locus[config.endField],
                    (locus["featureType"] || locus["type"]));

            });

            igv.browser.$searchResultsTable.append(row);

        });

    }

    /**
     * Parse the igv line-oriented (non json) search results.
     * Example
     *    EGFR    chr7:55,086,724-55,275,031    refseq
     *
     * @param data
     */
    function parseSearchResults(data) {

        var lines = data.splitLines(),
            linesTrimmed = [],
            results = [];

        lines.forEach(function (item) {
            if ("" === item) {
                // do nothing
            } else {
                linesTrimmed.push(item);
            }
        });

        linesTrimmed.forEach(function (line) {

            var tokens = line.split("\t"),
                source,
                locusTokens,
                rangeTokens;

            if (tokens.length >= 3) {

                locusTokens = tokens[1].split(":");
                rangeTokens = locusTokens[1].split("-");
                source = tokens[2].trim();

                results.push({
                    chromosome: igv.browser.genome.getChromosomeName(locusTokens[0].trim()),
                    start: parseInt(rangeTokens[0].replace(/,/g, '')),
                    end: parseInt(rangeTokens[1].replace(/,/g, '')),
                    type: ("gtex" === source ? "snp" : "gene")
                });

            }

        });

        return results;

    }

    function handleSearchResult(name, chr, start, end, type) {

        igv.browser.selection = new igv.GtexSelection('gtex' === type || 'snp' === type ? {snp: name} : {gene: name});

        if (end === undefined) {
            end = start + 1;
        }
        if (igv.browser.flanking) {
            start = Math.max(0, start - igv.browser.flanking);
            end += igv.browser.flanking;    // TODO -- set max to chromosome length
        }

        igv.browser.goto(chr, start, end);

        // Notify tracks (important for gtex).   TODO -- replace this with some sort of event model ?
        fireOnsearch.call(igv.browser, name, type);
    }

    function fireOnsearch(feature, type) {
        // Notify tracks (important for gtex).   TODO -- replace this with some sort of event model ?
        this.trackViews.forEach(function (tp) {
            var track = tp.track;
            if (track.onsearch) {
                track.onsearch(feature, type);
            }
        });
    }

    function addTrackContainerHandlers(trackContainerDiv) {

        var isRulerTrack = false,
            isMouseDown = false,
            isDragging = false,
            anchorVerticalLine = igv.browser.config.showGuideLine === 'center',
            lastMouseX = undefined,
            mouseDownX = undefined;

        $(trackContainerDiv).mousedown(function (e) {

            var coords = igv.translateMouseCoordinates(e, trackContainerDiv);

            if (igv.popover) {
                igv.popover.hide();
            }

            isRulerTrack = ($(e.target).parent().parent().parent()[0].dataset.rulerTrack) ? true : false;

            if (isRulerTrack) {
                return;
            }

            isMouseDown = true;
            lastMouseX = coords.x;
            mouseDownX = lastMouseX;
        });

        // Guide line should follow the mouse unless anchored to center, be bound within the track area, and offset
        // by 5 pixels so as not to interfere with mouse clicks.
        if (!anchorVerticalLine) {
            $(trackContainerDiv).mousemove(function (e) {
                var coords = igv.translateMouseCoordinates(e, trackContainerDiv),
                    lineX = Math.max(50, coords.x - 5);
                lineX = Math.min(igv.browser.trackContainerDiv.clientWidth - 65, lineX);
                $(igv.browser.guideLineDiv).css({left: lineX + 'px'});
            });
        }


        $(trackContainerDiv).mousemove(igv.throttle(function (e) {

            var coords = igv.translateMouseCoordinates(e, trackContainerDiv),
                maxEnd,
                maxStart,
                referenceFrame = igv.browser.referenceFrame;

            if (isRulerTrack) {
                return;
            }

            if (!referenceFrame) {
                return;
            }

            if (isMouseDown) { // Possibly dragging

                if (mouseDownX && Math.abs(coords.x - mouseDownX) > igv.browser.constants.dragThreshold) {

                    if (igv.browser.loadInProgress()) {
                        // ignore
                        return;
                    }

                    isDragging = true;

                    referenceFrame.shiftPixels(lastMouseX - coords.x);

                    // clamp left
                    referenceFrame.start = Math.max(0, referenceFrame.start);

                    // clamp right
                    var chromosome = igv.browser.genome.getChromosome(referenceFrame.chr);
                    maxEnd = chromosome.bpLength;
                    maxStart = maxEnd - igv.browser.trackViewportWidth() * referenceFrame.bpPerPixel;


                    if (referenceFrame.start > maxStart) referenceFrame.start = maxStart;

                    igv.browser.updateLocusSearch(referenceFrame);


                    igv.browser.repaint();
                    igv.browser.fireEvent('trackdrag');
                }

                lastMouseX = coords.x;

            }

        }, 10));

        $(trackContainerDiv).mouseup(mouseUpOrOut);

        $(trackContainerDiv).mouseleave(mouseUpOrOut);

        function mouseUpOrOut(e) {

            if (isRulerTrack) {
                return;
            }

            // Don't let vertical line interfere with dragging
            if (igv.browser.guideLineDiv
                && e.toElement === igv.browser.guideLineDiv
                && e.type === 'mouseleave') {
                return;
            }

            if (isDragging) {
                igv.browser.fireEvent('trackdragend');
                isDragging = false;
            }

            mouseDownX = undefined;
            isMouseDown = false;
            lastMouseX = undefined;
        }

    }


    /**
     * Infer properties format and track type from legacy "config.type" property
     *
     * @param config
     */
    function inferTypes(config) {

        function translateDeprecatedTypes(config) {

            if (config.featureType) {  // Translate deprecated "feature" type
                config.type = config.type || config.featureType;
                config.featureType = undefined;
            }

            if ("bed" === config.type) {
                config.type = config.type || "annotation";
                config.format = config.format || "bed";
            }

            if ("bam" === config.type) {
                config.type = "alignment";
                config.format = "bam"
            }

            if ("vcf" === config.type) {
                config.type = "variant";
                config.format = "vcf"
            }

            if ("t2d" === config.type) {
                config.type = "gwas";
            }

            if ("FusionJuncSpan" === config.type) {
                config.format = "FusionJuncSpan";
            }
        }

        function inferFileFormat(config) {

            if (config.format) return;

            var path = config.url || config.localFile.name,
                fn = path.toLowerCase(),
                idx,
                ext;

            //Strip parameters -- handle local files later
            idx = fn.indexOf("?");
            if (idx > 0) {
                fn = fn.substr(0, idx);
            }

            //Strip aux extensions .gz, .tab, and .txt
            if (fn.endsWith(".gz")) {
                fn = fn.substr(0, fn.length - 3);
            } else if (fn.endsWith(".txt") || fn.endsWith(".tab")) {
                fn = fn.substr(0, fn.length - 4);
            }


            idx = fn.lastIndexOf(".");
            ext = idx < 0 ? fn : fn.substr(idx);

            switch (ext) {

                case ".bw":
                    config.format = "bigwig";
                    break;
                case ".bb":
                    config.format = "bigbed";

                default:
                    config.format = ext.substr(1);   // Strip leading "."
            }
        }

        function inferTrackType(config) {

            if (config.type) return;

            switch (config.format) {
                case "bw":
                case "bigwig":
                case "wig":
                case "bedgraph":
                    config.type = "wig";
                    break;
                case "vcf":
                    config.type = "variant";
                    break;
                case "seg":
                    config.type = "seg";
                    break;
                case "bam":
                    config.type = "alignment";
                    break;
                default:
                    config.type = "annotation";

            }
        }

        translateDeprecatedTypes(config);

        if (undefined === config.sourceType && (config.url || config.localFile)) {
            config.sourceType = "file";
        }

        if ("file" === config.sourceType) {
            if (undefined === config.format) {
                inferFileFormat(config);
            }
        }

        if (undefined === config.type) {
            inferTrackType(config);
        }


    };

    igv.Browser.prototype.on = function (eventName, fn) {
        if (!this.eventHandlers[eventName]) {
            this.eventHandlers[eventName] = [];
        }
        this.eventHandlers[eventName].push(fn);
    };

    igv.Browser.prototype.un = function (eventName, fn) {
        if (!this.eventHandlers[eventName]) {
            return;
        }

        var callbackIndex = this.eventHandlers[eventName].indexOf(fn);
        if (callbackIndex !== -1) {
            this.eventHandlers[eventName].splice(callbackIndex, 1);
        }
    };

    igv.Browser.prototype.fireEvent = function (eventName, args, thisObj) {
        if (!this.eventHandlers[eventName]) {
            return;
        }

        var scope = thisObj || window;
        for (var i = 0, l = this.eventHandlers[eventName].length; i < l; i++) {
            var item = this.eventHandlers[eventName][i];
            var result = item.apply(scope, args);

            // If any of the handlers return any value, then return it
            if (result !== undefined) {
                return result;
            }
        }
    };

    return igv;
})
(igv || {});


